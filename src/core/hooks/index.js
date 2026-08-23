// The hook bus.
//
// This is the only way the core tells modules that something happened, and the only
// way modules observe each other. It exists so the core never has to `import` a
// feature: without it, "AFK auto-move needs to know when someone speaks" becomes a
// reference from core into a module, and the module stops being removable.
//
// Hook names are declared here rather than being free-form strings, so a typo is a
// startup error instead of a handler that silently never fires.

export const HOOKS = Object.freeze({
    PEER_JOIN: 'peer:join',
    PEER_LEAVE: 'peer:leave',
    PEER_MOVE: 'peer:move',
    CHANNEL_CREATE: 'channel:create',
    CHANNEL_DESTROY: 'channel:destroy',
    MESSAGE_SEND: 'message:send',
    PRODUCER_NEW: 'producer:new',
    PRODUCER_CLOSE: 'producer:close',
    MIC_ACTIVITY: 'mic:activity',
    SERVER_READY: 'server:ready',
    SERVER_STOPPING: 'server:stopping',
});

const KNOWN = new Set(Object.values(HOOKS));

export class HookBus {
    #handlers = new Map();
    #log;

    constructor(log) {
        this.#log = log;
    }

    /**
     * Subscribe. Returns an unsubscribe function — the loader keeps it so a module can
     * be disabled without leaving a listener behind that fires into dead code.
     */
    on(event, fn, owner = 'core') {
        if (!KNOWN.has(event)) {
            throw new Error(`Unknown hook "${event}". Declare it in HOOKS first.`);
        }
        if (typeof fn !== 'function') {
            throw new TypeError(`Handler for "${event}" must be a function`);
        }

        const entry = { fn, owner };
        if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
        this.#handlers.get(event).add(entry);

        return () => this.#handlers.get(event)?.delete(entry);
    }

    /**
     * Fire a hook. A throwing handler is logged and skipped, never propagated: one
     * badly-behaved module must not be able to break a join, a leave, or a call.
     */
    emit(event, payload) {
        const set = this.#handlers.get(event);
        if (!set?.size) return;

        for (const { fn, owner } of set) {
            try {
                fn(payload);
            } catch (err) {
                this.#log?.error(
                    { evt: 'hook.failed', hook: event, module: owner, err },
                    `Module "${owner}" threw handling ${event}; continuing`,
                );
            }
        }
    }

    /** Remove every handler owned by one module. Used when disabling it. */
    removeOwner(owner) {
        let removed = 0;
        for (const set of this.#handlers.values()) {
            for (const entry of set) {
                if (entry.owner === owner) { set.delete(entry); removed += 1; }
            }
        }
        return removed;
    }

    /** For diagnostics: which modules listen to what. */
    describe() {
        return [...this.#handlers.entries()]
            .filter(([, set]) => set.size > 0)
            .map(([event, set]) => ({ event, owners: [...set].map((e) => e.owner) }));
    }
}
