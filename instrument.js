const Sentry = require("@sentry/node");

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: true
  });
} else {
  console.warn("SENTRY_DSN not set; Sentry is disabled.");
}

module.exports = { Sentry };
