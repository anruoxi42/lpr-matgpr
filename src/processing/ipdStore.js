export class IpdStore extends EventTarget {
  constructor() {
    super();
    this.ipd = null;
    this.output = null;
    this.snapshots = [];
    this.datasets = [];
  }
  loadDataset(dataset) {
    const id = crypto.randomUUID();
    const createdAt = dataset.loadedAt || new Date().toLocaleString("zh-CN");
    const current = cloneDataset({ ...dataset, id, managerId: id, label: "Current Input Data" });
    this.ipd = { id, name: dataset.name, rawData: cloneDataset(current), current, history: [] };
    this.output = null;
    this.snapshots = [cloneDataset(current)];
    this.addManagedDataset(current, { id, kind: "上传数据", status: "当前", createdAt }, false);
    this.setManagedCurrent(id);
    this.emit();
  }
  get current() { return this.ipd?.current || null; }
  get rawData() { return this.ipd?.rawData || null; }
  get managedDatasets() { return this.datasets; }
  setOutput(data, step) {
    if (!this.ipd) return;
    const outputId = crypto.randomUUID();
    const output = cloneDataset({ ...this.current, ...data, id: outputId, managerId: outputId, label: "Output Data" });
    const kind = step?.op === "selection-extract" ? "提取数据" : "处理结果";
    const managerId = this.addManagedDataset(output, { kind, status: "待 Hold" }, false);
    this.output = cloneDataset({ ...output, managerId });
    this.pendingStep = { ...step, createdAt: new Date().toLocaleString("zh-CN") };
    this.emit();
  }
  holdOutput() {
    if (!this.ipd || !this.output) return false;
    const managerId = this.output.managerId || this.output.id;
    this.ipd.current = cloneDataset({ ...this.output, label: "Current Input Data" });
    this.ipd.name = this.ipd.current.name;
    this.ipd.history.push(this.pendingStep || { name: "Unknown process", params: {} });
    this.snapshots.push(cloneDataset(this.ipd.current));
    const item = this.getManagedDataset(managerId);
    if (item) item.acceptedAt = new Date().toLocaleString("zh-CN");
    this.setManagedCurrent(managerId);
    this.output = null;
    this.pendingStep = null;
    this.emit();
    return true;
  }
  discardOutput() {
    if (!this.output) return false;
    const item = this.getManagedDataset(this.output.managerId || this.output.id);
    if (item && item.managedStatus === "待 Hold") item.managedStatus = "已保存";
    this.output = null;
    this.pendingStep = null;
    this.emit();
    return true;
  }
  restore(index) {
    if (!this.ipd || !this.snapshots[index]) return false;
    this.ipd.current = cloneDataset(this.snapshots[index]);
    this.ipd.history = this.ipd.history.slice(0, Math.max(0, index));
    this.snapshots = this.snapshots.slice(0, index + 1);
    this.output = null;
    this.setManagedCurrent(this.ipd.current.managerId || this.ipd.current.id);
    this.emit();
    return true;
  }
  addManagedDataset(dataset, options = {}, emit = true) {
    const id = options.id || dataset.managerId || dataset.id || crypto.randomUUID();
    const previous = this.getManagedDataset(id);
    const item = cloneDataset({
      ...dataset,
      id,
      managerId: id,
      name: options.name || dataset.name || previous?.name || "data",
      managedKind: options.kind || dataset.managedKind || previous?.managedKind || "数据",
      managedStatus: options.status ?? dataset.managedStatus ?? previous?.managedStatus ?? "",
      managedCreatedAt: options.createdAt || dataset.loadedAt || dataset.managedCreatedAt || previous?.managedCreatedAt || new Date().toLocaleString("zh-CN"),
      acceptedAt: dataset.acceptedAt || previous?.acceptedAt || ""
    });
    const index = this.datasets.findIndex(d => d.id === id);
    if (index >= 0) this.datasets[index] = item;
    else this.datasets.push(item);
    if (emit) this.emit();
    return id;
  }
  setManagedCurrent(id) {
    for (const item of this.datasets) {
      item.isCurrent = item.id === id;
      if (item.isCurrent) item.managedStatus = "当前";
      else if (item.managedStatus === "当前") item.managedStatus = item.acceptedAt ? "已 Hold" : "已保存";
    }
  }
  getManagedDataset(id) {
    return this.datasets.find(d => d.id === id) || null;
  }
  renameManagedDataset(id, name) {
    const clean = String(name || "").trim();
    const item = this.getManagedDataset(id);
    if (!item || !clean) return false;
    item.name = clean;
    if (this.ipd?.current && (this.ipd.current.managerId === id || this.ipd.current.id === id)) {
      this.ipd.current.name = clean;
      this.ipd.name = clean;
    }
    if (this.ipd?.rawData && (this.ipd.rawData.managerId === id || this.ipd.rawData.id === id)) this.ipd.rawData.name = clean;
    if (this.output && (this.output.managerId === id || this.output.id === id)) this.output.name = clean;
    this.snapshots = this.snapshots.map(s => (s.managerId === id || s.id === id) ? cloneDataset({ ...s, name: clean }) : s);
    this.emit();
    return true;
  }
  updateCurrentMeta(meta = {}) {
    if (!this.ipd?.current) return false;
    const id = this.ipd.current.managerId || this.ipd.current.id;
    const nextMeta = { ...(this.ipd.current.meta || {}), ...meta };
    this.ipd.current.meta = nextMeta;
    if (this.ipd.rawData && (this.ipd.rawData.managerId === id || this.ipd.rawData.id === id)) this.ipd.rawData.meta = nextMeta;
    if (this.output && (this.output.managerId === id || this.output.id === id)) this.output.meta = nextMeta;
    const item = this.getManagedDataset(id);
    if (item) item.meta = nextMeta;
    this.snapshots = this.snapshots.map(s => (s.managerId === id || s.id === id) ? cloneDataset({ ...s, meta: nextMeta }) : s);
    this.emit();
    return true;
  }
  deleteManagedDatasets(ids = []) {
    const removeIds = new Set(Array.from(ids).filter(Boolean));
    if (!removeIds.size) return 0;
    const before = this.datasets.length;
    const currentId = this.ipd?.current?.managerId || this.ipd?.current?.id;
    const outputId = this.output?.managerId || this.output?.id;
    const deletesCurrent = currentId && removeIds.has(currentId);
    const deletesOutput = outputId && removeIds.has(outputId);
    this.datasets = this.datasets.filter(item => !removeIds.has(item.id));
    this.snapshots = this.snapshots.filter(item => !removeIds.has(item.managerId || item.id));
    if (deletesOutput || deletesCurrent) {
      this.output = null;
      this.pendingStep = null;
    }
    if (deletesCurrent) {
      const next = this.datasets[0];
      if (next) {
        const current = cloneDataset({ ...next, id: next.id, managerId: next.id, label: "Current Input Data" });
        this.ipd = { id: next.id, name: next.name, rawData: cloneDataset(current), current, history: [] };
        this.snapshots = [cloneDataset(current)];
        this.setManagedCurrent(next.id);
      } else {
        this.ipd = null;
        this.output = null;
        this.pendingStep = null;
        this.snapshots = [];
      }
    } else if (this.ipd) {
      this.setManagedCurrent(currentId);
      if (!this.snapshots.length) this.snapshots = [cloneDataset(this.ipd.current)];
    }
    const deleted = before - this.datasets.length;
    if (deleted) this.emit();
    return deleted;
  }
  useManagedDataset(id) {
    const item = this.getManagedDataset(id);
    if (!item) return false;
    const current = cloneDataset({ ...item, id: item.id, managerId: item.id, label: "Current Input Data" });
    this.ipd = { id: item.id, name: item.name, rawData: cloneDataset(current), current, history: [] };
    this.output = null;
    this.pendingStep = null;
    this.snapshots = [cloneDataset(current)];
    this.setManagedCurrent(item.id);
    this.emit();
    return true;
  }
  emit() { this.dispatchEvent(new Event("change")); }
}

export function cloneDataset(ds) {
  return {
    ...ds,
    data: new Float32Array(ds.data),
    meta: ds.meta,
    numTraces: ds.numTraces,
    numSamples: ds.numSamples
  };
}
