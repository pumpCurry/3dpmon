# Font Generation Guide

This guide outlines the `font_tools/train_pix2pix_updated.py` script. It trains a pix2pix network to convert reference font glyphs into the style of GD Highway Gothic JA and generates missing characters.

## Features
- Automatically renders training pairs from reference and target fonts
- Utilises a U-Net generator and PatchGAN discriminator
- Provides batch inference to create new glyph images

## Usage Steps
1. Set `TARGET_FONT_PATH` and `REFERENCE_FONT_PATH` to the font files for training.
2. Define the training glyphs in `common_chars_for_training`.
3. Run the script to render images under `data_updated/train/` and start training.
4. Checkpoints are stored in `checkpoints_gd_highwaygothic/` every epoch.
5. After training, characters listed in `missing_chars_to_generate` are generated to `output_gd_highwaygothic/`.

## Notes
- Generation quality strongly depends on the amount and quality of training pairs.
- The implementation uses `textbbox` for accurate centering when rendering glyphs.
