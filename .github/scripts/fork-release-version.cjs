// The next stable version of a fork published from Avalon: upstream's desktop
// patch times 100 plus a counter, so upstream 0.1.10 ships as 0.1.1000,
// 0.1.1001, ... and 0.1.11 as 0.1.1100 (the owner's scheme, 2026-11-20). The
// version says which upstream release it carries, and always rises.
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * @param {string} upstreamVersion apps/desktop/package.json's version, x.y.z
 * @param {ReadonlyArray<{ name: string, commit: { sha: string } }>} tags the repository's tags
 * @param {string} sha the commit to release
 * @returns {string | null} the version, or null when `sha` is already released
 */
function nextForkVersion(upstreamVersion, tags, sha) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(upstreamVersion);
  if (!match) throw new Error(`Unsupported upstream version: ${upstreamVersion}`);
  const [x, y, z] = match.slice(1).map(Number);
  const base = z * 100;
  let next = base;
  for (const tag of tags) {
    const t = STABLE_TAG.exec(tag.name);
    if (!t) continue;
    if (tag.commit.sha === sha) return null;
    const [tx, ty, tz] = t.slice(1).map(Number);
    if (tx === x && ty === y && tz >= base && tz < base + 100) next = Math.max(next, tz + 1);
  }
  if (next >= base + 100) throw new Error(`No fork version left for upstream ${upstreamVersion}`);
  return `${x}.${y}.${next}`;
}

/**
 * Whether fork-release.yml releases `sha`, and as which version. CI runs per commit in parallel
 * and can be re-run, so a success may arrive for a commit main has moved past; releasing it then
 * would ship older code under the newest version.
 * @returns {{ version: string } | { skip: string }}
 */
function forkRelease({ upstreamVersion, tags, sha, mainTip }) {
  if (sha !== mainTip) return { skip: `${sha} is no longer the tip of main (${mainTip}).` };
  const version = nextForkVersion(upstreamVersion, tags, sha);
  return version ? { version } : { skip: `${sha} is already released.` };
}

/**
 * The Android versionCode of fork version x.y.z: it must rise for a phone to update, and stay
 * below Android's limit of 2100000000.
 * @returns {number}
 */
function androidVersionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unsupported fork version: ${version}`);
  const [x, y, z] = match.slice(1).map(Number);
  if (x > 20 || y > 999 || z > 99999) throw new Error(`No Android versionCode for ${version}`);
  return Math.max(1, x * 100000000 + y * 100000 + z);
}

module.exports = { androidVersionCode, forkRelease, nextForkVersion };
