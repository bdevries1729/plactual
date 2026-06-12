import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';

function load() {
  if (!fs.existsSync(config.mappingsFile)) return [];
  try {
    return JSON.parse(fs.readFileSync(config.mappingsFile, 'utf8'));
  } catch {
    return [];
  }
}

function save(mappings) {
  fs.mkdirSync(path.dirname(config.mappingsFile), { recursive: true });
  fs.writeFileSync(config.mappingsFile, JSON.stringify(mappings, null, 2));
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

function update(id, mapping) {
  const mappings = load();
  const entry = { id: crypto.randomUUID(), ...mapping };
  mappings.push(entry);
  save(mappings);
  return entry;
}

export default { load, add, remove, save };
