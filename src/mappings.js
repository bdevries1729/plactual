const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.MAPPINGS_FILE || '/data/sync-files/mappings.json';

function removeDuplicatesByPlaidAccountId(mappings) {
  return mappings.filter((m, i, self) => i === self.findIndex(t => t.plaid_account_id === m.plaid_account_id));
}

function load() {
  if (!fs.existsSync(FILE)) return [];
  try {
    return removeDuplicatesByPlaidAccountId(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    return [];
  }
}

function save(mappings) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(removeDuplicatesByPlaidAccountId(mappings), null, 2));
}

function add(mapping) {
  const mappings = load();
  const entry = { id: crypto.randomUUID(), ...mapping };
  mappings.push(entry);
  save(mappings);
  return entry;
}

function remove(id) {
  const mappings = load().filter(m => m.id !== id);
  save(mappings);
}

module.exports = { load, save, add, remove, FILE };