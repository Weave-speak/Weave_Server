// Settings.
//
// Runtime configuration that an administrator can change, as opposed to the
// environment config that requires a restart. Settings are DECLARED with a type and a
// label, which is what lets the admin UI render a module's settings form without the
// module shipping any UI at all — a module says "I have a number between 1 and 1440
// called Timeout" and a control appears.
//
// Values live in SQLite as JSON. Declarations live in memory and are re-made on every
// boot, so a value belonging to a module that is currently disabled simply sits
// dormant rather than being lost.

export class SettingsError extends Error {}

const TYPES = new Set(['string', 'number', 'boolean', 'enum', 'text']);

function validate(schema, value) {
    switch (schema.type) {
        case 'boolean':
            if (typeof value !== 'boolean') return 'must be true or false';
            return true;
        case 'number': {
            if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
            if (schema.min !== undefined && value < schema.min) return `must be at least ${schema.min}`;
            if (schema.max !== undefined && value > schema.max) return `must be at most ${schema.max}`;
            if (schema.integer && !Number.isInteger(value)) return 'must be a whole number';
            return true;
        }
        case 'enum':
            if (!schema.values.includes(value)) return `must be one of: ${schema.values.join(', ')}`;
            return true;
        case 'string':
        case 'text': {
            if (typeof value !== 'string') return 'must be text';
            if (schema.maxLength && value.length > schema.maxLength) {
                return `must be ${schema.maxLength} characters or fewer`;
            }
            return true;
        }
        default:
            return `unknown setting type "${schema.type}"`;
    }
}

export class Settings {
    #db;
    #log;
    #declarations = new Map();
    #cache = new Map();

    constructor(db, log) {
        this.#db = db;
        this.#log = log;
        this.#load();
    }

    #load() {
        const rows = this.#db.prepare('SELECT key, value FROM settings').all();
        for (const row of rows) {
            try {
                this.#cache.set(row.key, JSON.parse(row.value));
            } catch {
                this.#log?.warn({ evt: 'settings.corrupt', key: row.key },
                    `Setting "${row.key}" is not valid JSON and was ignored`);
            }
        }
    }

    /**
     * Declare a setting. Returns a disposer so a module's declarations disappear when it
     * is disabled — the stored VALUE stays, so re-enabling restores what the admin chose.
     */
    define(key, schema, fallback, owner = 'core') {
        if (!TYPES.has(schema?.type)) {
            throw new SettingsError(`Setting "${key}" needs a type: one of ${[...TYPES].join(', ')}`);
        }
        if (schema.type === 'enum' && !Array.isArray(schema.values)) {
            throw new SettingsError(`Enum setting "${key}" needs a values array`);
        }
        if (this.#declarations.has(key)) {
            throw new SettingsError(`Setting "${key}" is already declared by "${this.#declarations.get(key).owner}"`);
        }

        const verdict = validate(schema, fallback);
        if (verdict !== true) {
            throw new SettingsError(`Default for "${key}" is invalid: ${verdict}`);
        }

        this.#declarations.set(key, { key, schema, fallback, owner });
        return () => this.#declarations.delete(key);
    }

    get(key) {
        if (this.#cache.has(key)) return this.#cache.get(key);
        return this.#declarations.get(key)?.fallback;
    }

    set(key, value) {
        const declared = this.#declarations.get(key);
        // Internal bookkeeping (module.<id>.enabled) is written before any declaration
        // exists, so only validate what has actually been declared.
        if (declared) {
            const verdict = validate(declared.schema, value);
            if (verdict !== true) {
                throw new SettingsError(`Cannot set "${key}": ${verdict}`);
            }
        }

        this.#db.prepare(`
            INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(key, JSON.stringify(value));

        this.#cache.set(key, value);
        this.#log?.info({ evt: 'settings.changed', key }, `Setting "${key}" changed`);
        return value;
    }

    /** Declared settings with current values, for the admin UI. Grouped by owner. */
    describe() {
        const out = new Map();
        for (const { key, schema, fallback, owner } of this.#declarations.values()) {
            if (!out.has(owner)) out.set(owner, []);
            out.get(owner).push({
                key,
                label: schema.label ?? key,
                help: schema.help ?? '',
                type: schema.type,
                values: schema.values,
                min: schema.min,
                max: schema.max,
                value: this.get(key),
                isDefault: !this.#cache.has(key),
                default: fallback,
            });
        }
        return [...out.entries()].map(([owner, items]) => ({ owner, items }));
    }
}
