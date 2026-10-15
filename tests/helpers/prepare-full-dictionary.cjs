"use strict";

// Playwright globalSetup：打包验收自己准备 Full 物料，不依赖 verify 分片的工作目录。
module.exports = async function prepareFullDictionary() {
  const source = await require("../../scripts/prepare-dictionary.cjs").prepareSource("full-text");
  process.env.LEXIMEET_DICTIONARY_TEST_SOURCE = source;
  return source;
};
