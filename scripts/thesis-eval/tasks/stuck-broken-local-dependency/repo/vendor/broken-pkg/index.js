// This package's postinstall script always exits 1 — `npm install` can
// never succeed against it, deterministically, offline, no network
// involved. See ../../package.json's dependency on "file:./vendor/broken-pkg"
// and this task's prompt.txt.
module.exports.leftPad = function leftPad(str, len) {
  str = String(str)
  while (str.length < len) str = ' ' + str
  return str
}
