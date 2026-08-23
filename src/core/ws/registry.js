// WebSocket message dispatch.
//
// The previous server switched on `msg.type` in one function with no default case, so
// an unknown type was silently dropped and adding a message meant editing the switch.
// Here handlers are registered and removable, unknown types get a real error back, and
// module message types are NAMESPACED (`chat:message`) so two modules can never
// collide on a name. Core keeps bare names (`join`, `ping`) because those are the
// protocol itself rather than a feature.

export class WsRegistry {
    #handlers = new Map(); // wire type -> { owner, handler, auth }
    #log;

    constructor(log) {
        this.#log = log;
    }

    /** Wire name for a type: core owns bare names, modules are namespaced by id. */
    static wireType(owner, type) {
        return owner === 'core' ? type : `${owner}:${type}`;
    }

    register(owner, type, handler, opts = {}) {
        const wire = WsRegistry.wireType(owner, type);

        const existing = this.#handlers.get(wire);
        if (existing) {
            throw new Error(`WebSocket type "${wire}" is already handled by "${existing.owner}"`);
        }
        if (typeof handler !== 'function') {
            throw new TypeError(`Handler for "${wire}" must be a function`);
        }

        this.#handlers.set(wire, { owner, handler, auth: opts.auth ?? 'user' });
        return () => this.#handlers.delete(wire);
    }

    get(type) {
        return this.#handlers.get(type);
    }

    /** Every live type, for diagnostics and for the client's capability negotiation. */
    get types() {
        return [...this.#handlers.keys()].sort();
    }

    removeOwner(owner) {
        let removed = 0;
        for (const [wire, entry] of this.#handlers) {
            if (entry.owner === owner) { this.#handlers.delete(wire); removed += 1; }
        }
        return removed;
    }
}
