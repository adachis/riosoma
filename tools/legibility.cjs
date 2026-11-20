/** Opaque sRGB helpers. Keep packages/tokens/src/legibility.ts in sync. */
function rgb(color) {
    if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color))
        throw new TypeError('Expected an sRGB hex color');
    const hex = color.length === 4 ? color.slice(1).split('').map((c) => c + c).join('') : color.slice(1);
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}
function linear(value) {
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function luminance(color) {
    const [r, g, b] = rgb(color).map(linear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG relative luminance contrast, from 1 through 21. */
function contrastRatio(a, b) {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function lab(color) {
    const [r, g, b] = rgb(color).map(linear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromLab(lightness, a, b) {
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
function atLightness(lightness, a, b) {
    // Scaling a and b together keeps the OKLCH hue and removes only out-of-gamut chroma.
    const inGamut = (channels) => channels.every((v) => v >= -1e-7 && v <= 1 + 1e-7);
    let channels = fromLab(lightness, a, b);
    if (!inGamut(channels)) {
        let low = 0, high = 1;
        for (let i = 0; i < 28; i++) {
            const scale = (low + high) / 2;
            if (inGamut(fromLab(lightness, a * scale, b * scale)))
                low = scale;
            else
                high = scale;
        }
        channels = fromLab(lightness, a * low, b * low);
    }
    return '#' + channels.map((v) => {
        const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
        return Math.round(Math.max(0, Math.min(1, encoded)) * 255).toString(16).padStart(2, '0');
    }).join('');
}
/** Mixes two opaque colors in OKLab, as CSS `color-mix(in oklab, a weight, b)` does. */
function mix(a, b, weight) {
    const x = lab(a), y = lab(b);
    return atLightness(x[0] * weight + y[0] * (1 - weight), x[1] * weight + y[1] * (1 - weight),
        x[2] * weight + y[2] * (1 - weight));
}
function validateTarget(target) {
    if (!Number.isFinite(target) || target < 1)
        throw new RangeError('Expected a finite contrast target of at least 1');
}
/**
 * Preserve a passing color. Otherwise find the smallest OKLCH lightness change that
 * passes every background with a 0.1 margin. Return null if that margin is impossible.
 * Results are lowercase six-digit hex colors. Empty backgrounds preserve the color.
 */
function adjustForContrast(color, backgrounds, target) {
    validateTarget(target);
    const original = '#' + rgb(color).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    const bgLuminances = backgrounds.map(luminance);
    if (backgrounds.every((bg) => contrastRatio(original, bg) >= target))
        return original;
    const goal = target + 0.1;
    // Each background excludes a luminance interval. Intersection also handles a
    // foreground between a dark and a light background, where neither endpoint works.
    let intervals = [[0, 1]];
    for (const bg of bgLuminances) {
        const dark = (bg + 0.05) / goal - 0.05;
        const light = goal * (bg + 0.05) - 0.05;
        intervals = intervals.flatMap(([lo, hi]) => {
            const next = [];
            if (lo <= Math.min(hi, dark))
                next.push([lo, Math.min(hi, dark)]);
            if (Math.max(lo, light) <= hi)
                next.push([Math.max(lo, light), hi]);
            return next;
        });
    }
    const [l, a, b] = lab(original);
    let best = null, distance = Infinity;
    for (const [minimum, maximum] of intervals) {
        // Search the rounded sRGB output, so quantization cannot erode the margin.
        let low = 0, high = 1;
        for (let i = 0; i < 48; i++) {
            const mid = (low + high) / 2;
            if (luminance(atLightness(mid, a, b)) < minimum)
                low = mid;
            else
                high = mid;
        }
        const start = high;
        low = 0;
        high = 1;
        for (let i = 0; i < 48; i++) {
            const mid = (low + high) / 2;
            if (luminance(atLightness(mid, a, b)) > maximum)
                high = mid;
            else
                low = mid;
        }
        const end = low;
        if (start > end)
            continue;
        const nextL = Math.max(start, Math.min(end, l));
        const next = atLightness(nextL, a, b);
        if (backgrounds.every((bg) => contrastRatio(next, bg) >= goal) && Math.abs(nextL - l) < distance) {
            best = next;
            distance = Math.abs(nextL - l);
        }
    }
    return best;
}
/**
 * Candidates are ordered as the original on-color, body text, and page color.
 * Keep the first passing candidate, then adjust the original, then try black and white.
 */
function legibleOn(fill, candidates, target) {
    validateTarget(target);
    rgb(fill);
    for (const candidate of candidates) {
        if (contrastRatio(candidate, fill) >= target)
            return adjustForContrast(candidate, [fill], target);
    }
    if (candidates[0]) {
        const adjusted = adjustForContrast(candidates[0], [fill], target);
        if (adjusted)
            return adjusted;
    }
    for (const candidate of ['#000000', '#ffffff']) {
        if (contrastRatio(candidate, fill) >= target)
            return candidate;
    }
    return null;
}

module.exports = { contrastRatio, adjustForContrast, legibleOn, mix };
