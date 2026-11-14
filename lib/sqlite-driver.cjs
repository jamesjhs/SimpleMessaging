'use strict';

// v13 uses Node-API for compatibility across Node majors. ARM32 retains the
// v12 prebuild because upstream v13 no longer bundles an ARMv7 binary.
/** @returns {import('better-sqlite3').DatabaseConstructor} */
function loadDriver() {
  if (process.platform === 'linux' && process.arch === 'arm') {
    if (Number(process.versions.node.split('.')[0]) !== 22) {
      throw new Error('The 32-bit Raspberry Pi database driver requires Node.js 22.');
    }
    try {
      return require('@tls/sqlite-arm32');
    } catch (error) {
      throw new Error('ARM32 database driver unavailable. Run npm ci --include=dev --include=optional under Node.js 22 on the Pi.', { cause: error });
    }
  }
  return require('better-sqlite3-multiple-ciphers');
}
module.exports = loadDriver();
