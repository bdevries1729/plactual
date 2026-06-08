const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.MAPPINGS_FILE || '/data/mappings.json';

function load() {
  if (!fs.existsSync(FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(mappings) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(mappings, null, 2));
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