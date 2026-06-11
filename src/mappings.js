const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config')

function removeDuplicatesByPlaidAccountId(mappings) {
  return mappings.filter((m, i, self) => i === self.findIndex(t => t.plaid_account_id === m.plaid_account_id));
}

function load() {
  if (!fs.existsSync(config.mappingsFile)) return [];
  try {
    return removeDuplicatesByPlaidAccountId(JSON.parse(fs.readFileSync(config.mappingsFile, 'utf8')));
  } catch {
    return [];
  }
}

function save(mappings) {
  fs.mkdirSync(path.dirname(config.mappingsFile), { recursive: true });
  fs.writeFileSync(config.mappingsFile, JSON.stringify(removeDuplicatesByPlaidAccountId(mappings), null, 2));
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

module.exports = { load, save, add, remove };
