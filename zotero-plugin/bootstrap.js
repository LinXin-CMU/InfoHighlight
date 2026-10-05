var InfoLensPlugin, pluginScope;
function install() {}
function uninstall() {}
async function startup({id, rootURI}) {
  // This alpha is upgraded manually. The required update URL is loopback-only;
  // no TLS updater is shipped and no external update host is contacted.
  const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const addon=await AddonManager.getAddonByID(id);
  if(addon)addon.applyBackgroundUpdates=AddonManager.AUTOUPDATE_DISABLE;
  // Keep callbacks in a scope owned by the addon, across toolbar re-renders.
  const timers=ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
  pluginScope = {Zotero, Services, Components, ChromeUtils, Intl, setTimeout:timers.setTimeout, clearTimeout:timers.clearTimeout, setInterval:timers.setInterval, clearInterval:timers.clearInterval};
  for (const name of ['core.js', 'infolens.js']) Services.scriptloader.loadSubScriptWithOptions(rootURI + name, {target:pluginScope, ignoreCache:true});
  InfoLensPlugin = pluginScope.InfoLensPlugin;
  InfoLensPlugin.start({id});
  Zotero.InfoLens = InfoLensPlugin;
}
function shutdown() {
  try { InfoLensPlugin?.stop(); }
  finally {
    if (Zotero.InfoLens === InfoLensPlugin) delete Zotero.InfoLens;
    InfoLensPlugin = undefined; pluginScope = undefined;
  }
}
