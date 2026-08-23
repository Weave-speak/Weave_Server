// Admin panel registry.
//
// A module contributes a panel by declaring it; the admin SPA fetches the list and
// renders navigation from it. Modules do not ship markup — they ship a declaration
// plus, usually, a set of declared settings, and the generic settings form covers the
// common case. A panel only needs `dataRoute` when it does something a form cannot.

export class AdminRegistry {
    #panels = new Map();

    register(owner, panel) {
        if (!panel?.id) throw new Error(`Admin panel from "${owner}" needs an id`);
        const key = `${owner}:${panel.id}`;
        if (this.#panels.has(key)) {
            throw new Error(`Admin panel "${key}" is already registered`);
        }

        this.#panels.set(key, {
            key,
            owner,
            id: panel.id,
            label: panel.label ?? panel.id,
            icon: panel.icon ?? null,
            order: panel.order ?? 100,
            // Where the panel gets its data. Omit for a panel that is purely declared
            // settings — the generic form handles those.
            dataRoute: panel.dataRoute ?? null,
        });

        return () => this.#panels.delete(key);
    }

    get panels() {
        return [...this.#panels.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
    }

    removeOwner(owner) {
        for (const [key, panel] of this.#panels) {
            if (panel.owner === owner) this.#panels.delete(key);
        }
    }
}
