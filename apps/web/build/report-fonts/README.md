The PDF report fallback embeds the regular and bold Noto Sans CJK Japanese fonts from release 2.004.  Both cover Japanese, Korean, and Chinese characters.  Fonts are distributed under the included SIL Open Font License.

Source: https://github.com/notofonts/noto-cjk/tree/Sans2.004/Sans/OTF/Japanese

Regular and bold Noto Sans Arabic and Noto Sans Hebrew cover right-to-left report content under the same SIL Open Font License.  Source: https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf

The web build packages the font files and derives glyph coverage from these exact files and the renderer's bundled Roboto fonts.  This keeps offline rendering and missing-character detection aligned.
