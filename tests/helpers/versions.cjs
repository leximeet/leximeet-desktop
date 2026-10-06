// 比较核心数值版本，并处理预发布版本；拒绝把相同版本的重启冒充升级。
function compareVersion(first, second) {
  const parse = (value) => {
    const match =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
        value,
      );
    if (!match) throw new Error(`应用版本不是 SemVer：${value}`);
    const prerelease = match[4]?.split(".");
    if (prerelease?.some((part) => /^0\d+$/.test(part)))
      throw new Error(`应用版本不是 SemVer：${value}`);
    return { numbers: match.slice(1, 4).map(BigInt), prerelease };
  };
  const a = parse(first);
  const b = parse(second);
  for (let index = 0; index < 3; index++)
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

module.exports = { compareVersion };
