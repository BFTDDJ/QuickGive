const Sentry = require("@sentry/node");

Sentry.init({
  dsn: "https://01e2d4979f6eb3ee93ee061cbc4a170d@o4510835062276096.ingest.us.sentry.io/4510835067715584",
  sendDefaultPii: true
});

module.exports = { Sentry };
