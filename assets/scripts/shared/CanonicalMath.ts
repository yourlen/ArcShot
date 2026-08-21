export function roundAway(value: number): number {
    if (!Number.isFinite(value) || value === 0) return 0;
    const rounded = Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
    return Object.is(rounded, -0) ? 0 : rounded;
}

export function fnv1aAscii(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code > 0x7f) {
            throw new Error('FNV_ASCII_ONLY');
        }
        hash ^= code;
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    const hex = hash.toString(16);
    return `${'00000000'.slice(hex.length)}${hex}`;
}

export function isSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value);
}

export function hasExactKeys(value: object, keys: string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}
