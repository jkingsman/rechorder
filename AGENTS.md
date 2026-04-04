# Rechorder

Rechorder is a browser-based text-to-audio synthesizer. Musical passages are
described in a concise plain-text notation, parsed in real-time, and played back
through the Web Audio API with per-channel voices, easing-based glissando,
microtonal tuning, and live visualization.

## Architecture

```
index.html          — layout, cheatsheet, controls
js/main.js          — editor wiring, timeline rendering, URL sharing, UI glue
js/parser.js        — text → parsed channels/elements
js/engine.js        — parsed elements → timeline segments, Player (Web Audio)
js/notes.js         — note-name ↔ frequency helpers, cent adjustment
js/tuning.js        — frequency tables (12-TET, custom), custom note registry
js/easing.js        — easing functions (13 named easings, case-insensitive)
js/rechorder-lang.js — CodeMirror 6 stream parser, syntax highlighting, tooltips,
                       decoration state fields (hover, playback, label colors)
```

### Data flow

1. **Editor** (CodeMirror 6) emits text on change.
2. **Parser** splits into lines, strips comments, classifies headers vs channels,
   splits channel bodies on `>`, and classifies each element (note, silence,
   transition, custom note, raw Hz, cent-adjusted note).
3. **Engine** converts parsed elements into a timeline of segments (note holds,
   slides with easing functions), with log-frequency interpolation for slides.
4. **Player** creates Web Audio nodes (oscillators → per-channel gains →
   master gain → highpass → lowpass → destination + convolver → reverb gain →
   destination) and drives them with a 10ms `setInterval` tick for audio
   (background-tab safe) and `requestAnimationFrame` for UI.
5. **Timeline** renders frequency traces on a canvas with volume-as-brightness,
   segment boundary lines, note labels, and channel name labels.

### Build

Vite. `npm run dev` for development, `npm run build` for production.

---

## Rechorder Notation — BNF Grammar

The grammar below is a complete, faithful description of what the parser accepts.
Matching is case-insensitive for headers, voices, easings, and silence. Note
letter names accept both cases. Comments use `#` preceded by whitespace or at
column 0.

```
<document>        ::= <line> ( NEWLINE <line> )*

<line>             ::= <comment-line>
                     | <header-line>
                     | <skipped-header>
                     | <channel-line>
                     | <empty-line>

<empty-line>       ::= WHITESPACE*

<comment-line>     ::= WHITESPACE* "#" TEXT-TO-EOL

<comment-suffix>   ::= WHITESPACE "#" TEXT-TO-EOL
                     | ε

<header-line>      ::= "L" ":" WHITESPACE* DIGITS WHITESPACE* "/" WHITESPACE* DIGITS
                         <comment-suffix>

<skipped-header>   ::= HEADER-LETTER ":" TEXT-TO-EOL
HEADER-LETTER      ::= [TMKQXVWtmkqxvw]

<channel-line>     ::= <channel-prefix> <body> <comment-suffix>

<channel-prefix>   ::= <name> "|" <voice> "|"
                     | <name> "|"
                     | <voice> "|"
                     | ε

<name>             ::= TEXT-WITHOUT-PIPE         /* any chars except "|"; trimmed;
                                                    must not match a <voice> when
                                                    the line has exactly one "|" */

<voice>            ::= "sine"
                     | "triangle" | "tri"
                     | "square"
                     | "sawtooth" | "saw"
                         /* case-insensitive */

<body>             ::= <element> ( ">" <element> )*

<element>          ::= <accent>? <element-name> ":" <duration>? <volume>? <pan>?

<accent>           ::= "!"

<element-name>     ::= <silence>
                     | <raw-hz>
                     | <standard-note>
                     | <cent-note>
                     | <custom-note>
                     | <easing>

<silence>          ::= "S" | "s"

<raw-hz>           ::= DIGITS ( "." DIGITS )?
                         /* must parse to a finite number > 0 */

<standard-note>    ::= NOTE-LETTER ACCIDENTAL? OCTAVE

<cent-note>        ::= NOTE-LETTER ACCIDENTAL? OCTAVE CENT-OFFSET

NOTE-LETTER        ::= [A-Ga-g]

ACCIDENTAL         ::= "#" | "b"

OCTAVE             ::= DIGITS

CENT-OFFSET        ::= ( "+" | "-" ) DIGITS

<custom-note>      ::= IDENT
                         /* must not match <silence>, <standard-note>,
                            <raw-hz>, or <easing>;
                            resolved against the custom note registry;
                            unknown names produce an error */

IDENT              ::= [A-Za-z_] [A-Za-z0-9_#]*

<easing>           ::= "lin" | "linear"
                     | "sineIn" | "sineOut" | "sineInOut"
                     | "cubicIn" | "cubicOut" | "cubicInOut"
                     | "quintIn" | "quintOut" | "quintInOut"
                     | "wobbleIn" | "wobbleOut" | "wobbleInOut"
                         /* case-insensitive */

<duration>         ::= DIGITS? ( "/" DIGITS )?
                         /* empty or omitted → 1;
                            "/N" → 1/N;
                            "N" → N;
                            "N/M" → N/M;
                            must be finite and >= 0;
                            0 is valid (tone anchor, no sustain) */

<volume>           ::= "=" DIGITS
                         /* 0–100; normalized to 0.0–1.0 internally;
                            omitted → null (engine defaults to 1.0);
                            slides interpolate between adjacent volumes */

<pan>              ::= "(" DIGITS "/" DIGITS ")"
                         /* (L/R) where L and R are 0–100;
                            each value scales the note's volume for that ear
                            independently (e.g., (100/0) = hard left,
                            (0/100) = hard right, (100/100) = center);
                            omitted → null (inherits last specified pan,
                            defaults to (100/100) if never set);
                            (0/0) = mute regardless of volume;
                            slides interpolate L and R independently */

DIGITS             ::= [0-9]+

WHITESPACE         ::= [ \t]+

TEXT-TO-EOL        ::= .* (to end of line)

TEXT-WITHOUT-PIPE  ::= [^|]+
```

### Semantics not captured in the grammar

- **Comment rule**: `#` only starts a comment when at column 0 or preceded by
  whitespace. A `#` inside a token (e.g., `C#4`, `c##4`) is part of that token.
- **Voice disambiguation**: with exactly one `|`, the left side is tested as a
  voice name first. If it matches, it is the voice; otherwise it is the channel
  name.
- **Accent**: only meaningful on notes (silence, raw Hz, standard, cent-adjusted,
  custom). Ignored on easings. Produces a 200% → 100% volume decay over the
  first 1/8th of the note's duration.
- **Element ordering**: a `<transition>` (easing) looks backward for the nearest
  preceding note and forward for the nearest following note to determine the
  slide's start/end frequencies and volumes. Slides between silence (freq=0) and
  a note are skipped (log-frequency interpolation is undefined at 0).
- **Step re-articulation**: two adjacent notes (no easing between them) produce
  an 8ms gain dip to simulate a re-strike.
- **Default duration unit**: set by the `L:` header (default `1/8`). At
  120 BPM with `L:1/4`, one duration unit = one quarter note.
- **Pan persistence**: once a pan value `(L/R)` is set on a note, it persists
  for all subsequent notes in that channel (including through silence) until
  another pan value is specified. Slides interpolate L and R independently
  between adjacent notes that both have explicit pan values.
- **Looping**: playback loops at `maxDuration` (the longest channel).

### Custom notes definition (separate textarea)

```
<custom-line>  ::= IDENT WHITESPACE* "=" WHITESPACE* <custom-value>
                 | "#" TEXT-TO-EOL
                 | WHITESPACE*

<custom-value> ::= DIGITS ( "." DIGITS )?          /* raw Hz */
                 | <standard-note>                  /* reference pitch */
                 | <cent-note>                      /* note ± cents */
```

Custom note names must start with a letter or `_`, may contain letters, digits,
`_`, and `#`, and must not conflict with standard note names, silence, or easing
names.
