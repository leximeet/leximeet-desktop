"use strict";

function posixQuote(text) {
  return `'${String(text).replaceAll("'", `'\\''`)}'`;
}

function powershellQuote(text) {
  return `'${String(text).replaceAll("'", "''")}'`;
}

function quoteForShell(text, platform = process.platform) {
  return platform === "win32" ? powershellQuote(text) : posixQuote(text);
}

module.exports = { posixQuote, powershellQuote, quoteForShell };
