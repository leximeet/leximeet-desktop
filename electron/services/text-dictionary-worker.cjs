"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { buildIndex } = require("./text-dictionary-index.cjs");
buildIndex({
  ...workerData,
  onProgress: (progress) => parentPort.postMessage({ progress }),
})
  .then((value) => parentPort.postMessage({ result: value }))
  .catch((error) => {
    parentPort.postMessage({ error: error.message });
    process.exitCode = 1;
  });
