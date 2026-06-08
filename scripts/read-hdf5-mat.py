import argparse
import base64
import json
import sys

import h5py
import numpy as np


def matlab_dims(shape):
    dims = list(reversed([int(v) for v in shape]))
    if not dims:
        return [1, 1]
    if len(dims) == 1:
        return [dims[0], 1]
    return dims


def matlab_class(dataset):
    value = dataset.attrs.get("MATLAB_class", b"")
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, np.bytes_):
        return bytes(value).decode("utf-8", "replace")
    return str(value or "")


def encode_numeric_dataset(dataset):
    if dataset.dtype.kind not in "fiu b":
        return None
    data = np.asarray(dataset[()])
    dims = matlab_dims(data.shape)
    rows = int(dims[0] if dims else 1)
    cols = int(dims[1] if len(dims) > 1 else 1)
    flat = np.ascontiguousarray(data.astype("<f4", copy=False)).ravel(order="C")
    payload = base64.b64encode(flat.tobytes()).decode("ascii")
    return {
        "data": {
            "encoding": "base64",
            "dtype": "float32",
            "value": payload,
            "length": int(flat.size),
        },
        "rows": rows,
        "cols": cols,
        "dims": dims,
        "type": matlab_class(dataset) or str(dataset.dtype),
        "sourceDtype": str(dataset.dtype),
        "hdf5Shape": [int(v) for v in data.shape],
    }


def read_file(path):
    variables = {}
    with h5py.File(path, "r") as handle:
        def visit(name, obj):
            if not isinstance(obj, h5py.Dataset):
                return
            if name.startswith("#refs#"):
                return
            encoded = encode_numeric_dataset(obj)
            if encoded is not None:
                variables[name.split("/")[-1]] = encoded

        handle.visititems(visit)
    return {"variables": variables}


def main():
    parser = argparse.ArgumentParser(description="Read numeric datasets from a MATLAB 7.3/HDF5 file.")
    parser.add_argument("path")
    args = parser.parse_args()
    json.dump(read_file(args.path), sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
