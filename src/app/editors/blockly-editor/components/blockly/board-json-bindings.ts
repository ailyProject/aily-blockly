/** Board bindings are whole JSON values, not JavaScript or string interpolation. */
export class BoardBindingError extends Error {
    readonly code = 'BOARD_BINDING_INVALID';
    constructor(readonly location: string, readonly reference: string, detail: string) {
        super(`${location}: ${reference}: ${detail}`);
        this.name = 'BoardBindingError';
    }
}

export function resolveBoardJsonBindings(source: unknown, board: any): any {
    const available = Object.keys(board || {}).filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
    const visit = (value: any, location: string): any => {
        if (typeof value === 'string' && value.startsWith('${board.')) {
            const key = /^\$\{board\.([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
            if (!key) throw new BoardBindingError(location, value, 'Use a whole-value ${board.key} reference; nested paths and expressions are not supported.');
            if (!board || !Object.prototype.hasOwnProperty.call(board, key) || board[key] === undefined) {
                throw new BoardBindingError(location, value, `Field is unavailable on this board. Available fields: ${available.join(', ') || '(none)'}.`);
            }
            // Copy data only; never evaluate or recursively expand board-provided strings.
            return JSON.parse(JSON.stringify(board[key]));
        }
        if (Array.isArray(value)) return value.map((item, index) => visit(item, `${location}[${index}]`));
        if (value && typeof value === 'object') {
            const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, `${location}.${key}`)]));
            if (result['type'] === 'field_dropdown' && typeof value.options === 'string' && value.options.startsWith('${board.')) {
                const options = result['options'];
                if (!Array.isArray(options) || !options.length || !options.every(option =>
                    Array.isArray(option) && option.length === 2 && typeof option[0] === 'string' && typeof option[1] === 'string')) {
                    throw new BoardBindingError(`${location}.options`, value.options, 'Expected a non-empty dropdown list of [label, string value] pairs.');
                }
            }
            return result;
        }
        return value;
    };
    return visit(source, typeof (source as any)?.type === 'string' ? (source as any).type : 'block.json');
}

/** Locales own labels, never dropdown values, order, or board-dependent option sources. */
export function translateDropdownOptions(options: any, translated: any): any {
    if (!Array.isArray(options) || !Array.isArray(translated)) return options;
    return options.map(option => {
        if (!Array.isArray(option)) return option;
        const match = translated.find(item => Array.isArray(item) && item[1] === option[1]);
        if (!match) return option;
        if (typeof option[0] === 'string' && typeof match[0] === 'string') return [match[0], option[1]];
        if (option[0] && typeof option[0] === 'object' && typeof match[0]?.alt === 'string') {
            return [{ ...option[0], alt: match[0].alt }, option[1]];
        }
        return option;
    });
}
