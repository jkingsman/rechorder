const { cos, sin, PI, pow } = Math;

const EASINGS = {
    lin:        t => t,
    linear:     t => t,
    sineIn:     t => 1 - cos(t * PI / 2),
    sineOut:    t => sin(t * PI / 2),
    sineInOut:  t => -(cos(PI * t) - 1) / 2,
    cubicIn:    t => t * t * t,
    cubicOut:   t => 1 - pow(1 - t, 3),
    cubicInOut: t => t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2,
    quintIn:    t => pow(t, 5),
    quintOut:   t => 1 - pow(1 - t, 5),
    quintInOut: t => t < 0.5 ? 16 * pow(t, 5) : 1 - pow(-2 * t + 2, 5) / 2,
    wobbleIn: t => t === 0 ? 0 : t === 1 ? 1
        : -pow(2, 10 * t - 10) * sin((10 * t - 10.75) * (2 * PI) / 3),
    wobbleOut: t => t === 0 ? 0 : t === 1 ? 1
        : pow(2, -10 * t) * sin((10 * t - 0.75) * (2 * PI) / 3) + 1,
    wobbleInOut: t => t === 0 ? 0 : t === 1 ? 1 : t < 0.5
        ? -(pow(2, 20 * t - 10) * sin((20 * t - 11.125) * (2 * PI) / 4.5)) / 2
        :  (pow(2, -20 * t + 10) * sin((20 * t - 11.125) * (2 * PI) / 4.5)) / 2 + 1,
};

// Build a case-insensitive lookup
const EASING_LOOKUP = {};
for (const key of Object.keys(EASINGS)) {
    EASING_LOOKUP[key.toLowerCase()] = EASINGS[key];
}

export function getEasing(name) {
    return EASING_LOOKUP[name.toLowerCase()] || null;
}
