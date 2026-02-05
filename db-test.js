// db-test.js
const { healthcheck } = require("./db");

(async () => {
  const row = await healthcheck();
  console.log("DB OK:", row);
  process.exit(0);
})();

