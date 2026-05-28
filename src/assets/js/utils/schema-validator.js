/**
 * Validates that the panel's API schema is compatible with this Launcher version.
 */
'use strict';

const SUPPORTED_SCHEMA_VERSION = '1.0.0';

async function fetchSchema(panelUrl) {
    const base = panelUrl.endsWith('/') ? panelUrl : `${panelUrl}/`;
    try {
        const res = await fetch(`${base}api-schema.json`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        // Fall back to installer-style endpoint
        try {
            const res = await fetch(`${base}?execute=php&action=api-schema`, {
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
                signal: AbortSignal.timeout(4000),
            });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    }
}

function isCompatible(schema) {
    if (!schema || !schema.schemaVersion) return true; // unknown schema — assume compatible
    const [major] = schema.schemaVersion.split('.');
    const [supported] = SUPPORTED_SCHEMA_VERSION.split('.');
    return major === supported;
}

async function validatePanel(panelUrl) {
    const schema = await fetchSchema(panelUrl);
    return {
        schema,
        compatible: isCompatible(schema),
        version: schema?.schemaVersion ?? null,
    };
}

export { validatePanel, isCompatible };
