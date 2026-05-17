export class IpdStore extends EventTarget {
  constructor() {
    super();
    this.ipd = null;
    this.output = null;
    this.snapshots = [];
  }
  loadDataset(dataset) {
    const id = crypto.randomUUID();
    const current = cloneDataset({ ...dataset, id, label: "Current Input Data" });
    this.ipd = { id, name: dataset.name, rawData: cloneDataset(current), current, history: [] };
    this.output = null;
    this.snapshots = [cloneDataset(current)];
    this.emit();
  }
  get current() { return this.ipd?.current || null; }
  get rawData() { return this.ipd?.rawData || null; }
  setOutput(data, step) {
    if (!this.ipd) return;
    this.output = cloneDataset({ ...this.current, ...data, id: crypto.randomUUID(), label: "Output Data" });
    this.pendingStep = { ...step, createdAt: new Date().toLocaleString("zh-CN") };
    this.emit();
  }
  holdOutput() {
    if (!this.ipd || !this.output) return false;
    this.ipd.current = cloneDataset({ ...this.output, label: "Current Input Data" });
    this.ipd.history.push(this.pendingStep || { name: "Unknown process", params: {} });
    this.snapshots.push(cloneDataset(this.ipd.current));
    this.output = null;
    this.pendingStep = null;
    this.emit();
    return true;
  }
  discardOutput() {
    if (!this.output) return false;
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
