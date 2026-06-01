#!/usr/bin/env node
const apiBaseUrl = process.env.QUICKGIVE_API_BASE_URL || 'https://quickgive-dafl8.ondigitalocean.app';
const adminToken = process.env.EVENT_ACCESS_ADMIN_TOKEN;

function usage() {
  console.error('Usage: node scripts/parent-access-admin.js <approve|revoke> <schoolId> <userId> [notes]');
  process.exit(1);
}

async function main() {
  const [, , action, schoolId, userId, ...noteParts] = process.argv;
  if (!action || !schoolId || !userId) usage();
  if (!['approve', 'revoke'].includes(action)) usage();
  if (!adminToken) {
    console.error('Missing EVENT_ACCESS_ADMIN_TOKEN');
    process.exit(1);
  }

  const notes = noteParts.join(' ').trim();
  const endpoint = `${apiBaseUrl}/internal/schools/${schoolId}/parent-access/${userId}/${action}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-access-admin-token': adminToken
    },
    body: JSON.stringify(notes ? { notes } : {})
  });

  const bodyText = await response.text();
  if (!response.ok) {
    console.error(`Request failed: HTTP ${response.status}`);
    console.error(bodyText);
    process.exit(1);
  }

  try {
    console.log(JSON.stringify(JSON.parse(bodyText), null, 2));
  } catch {
    console.log(bodyText);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
