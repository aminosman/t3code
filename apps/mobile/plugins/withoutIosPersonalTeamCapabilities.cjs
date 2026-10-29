const { withEntitlementsPlist } = require("expo/config-plugins");

// Personal teams cannot sign push. Paid teams can opt in with T3CODE_IOS_KEEP_PUSH=1.
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
