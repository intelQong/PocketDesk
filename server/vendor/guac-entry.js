// Bundled by esbuild with --global-name=Guacamole so the browser gets the
// classic `window.Guacamole` namespace regardless of how the npm mirror of
// guacamole-common-js structures its exports.
const G = require('guacamole-common-js');
module.exports = (G && (G.Guacamole || G.default)) || G;
