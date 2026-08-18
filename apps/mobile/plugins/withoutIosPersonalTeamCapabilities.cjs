const { withEntitlementsPlist } = require("expo/config-plugins");

/**
 * Strips entitlements a free Apple Developer ("personal") team cannot sign.
 *
 * A *paid* team building under its own bundle id is a different case: it can
 * sign push, it just isn't the T3 Tools org. `T3CODE_IOS_KEEP_PUSH=1` keeps
 * `aps-environment` so those builds can register for notifications, provided
 * the App ID has the Push Notifications capability enabled.
 */
module.exports = function withoutIosPersonalTeamCapabilities(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    if (process.env.T3CODE_IOS_KEEP_PUSH !== "1") {
      delete modConfig.modResults["aps-environment"];
    }
    delete modConfig.modResults["com.apple.developer.applesignin"];
    delete modConfig.modResults["com.apple.security.application-groups"];
    return modConfig;
  });
};
