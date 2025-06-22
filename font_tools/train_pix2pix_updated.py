# -*- coding: utf-8 -*-
"""pix2pix-based font generation training and inference script.

This script renders training images from font files, trains a pix2pix
network on paired source/target glyphs, and can generate missing glyphs
using the trained model.
"""

import os
import glob
import io
from typing import Dict
from PIL import Image, ImageDraw, ImageFont
import torch
from torch import nn, optim
from torch.utils.data import Dataset, DataLoader
import torchvision.transforms as T


def render_char_to_png(font_path: str, char: str, out_path_or_buffer, size: int = 256) -> Image.Image:
    """Render a single character to PNG, saving to a file path or a BytesIO.

    Args:
        font_path (str): Font file path used for rendering.
        char (str): Character to render.
        out_path_or_buffer (Union[str, io.BytesIO]): Output path or buffer.
        size (int, optional): Image square size. Defaults to 256.

    Returns:
        PIL.Image.Image: Generated image.
    """
    font = ImageFont.truetype(font_path, int(size * 0.8))
    img = Image.new("L", (size, size), color=255)
    draw = ImageDraw.Draw(img)
    try:
        bbox = draw.textbbox((0, 0), char, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        x = (size - text_width) / 2 - bbox[0]
        y = (size - text_height) / 2 - bbox[1]
    except AttributeError:
        text_width, text_height = draw.textsize(char, font=font)
        ascent, _ = font.getmetrics()
        x = (size - text_width) / 2
        y = (size - ascent) / 2 - (size * 0.05)
    draw.text((x, y), char, font=font, fill=0)
    if isinstance(out_path_or_buffer, str):
        img.save(out_path_or_buffer)
    elif isinstance(out_path_or_buffer, io.BytesIO):
        img.save(out_path_or_buffer, format="PNG")
        out_path_or_buffer.seek(0)
    return img


class FontPairDataset(Dataset):
    """Dataset handling paired source/target character images."""

    def __init__(self, source_dir: str, target_dir: str, transform=None) -> None:
        self.src_paths = sorted(glob.glob(os.path.join(source_dir, "*.png")))
        self.tgt_paths = []
        for p in self.src_paths:
            tgt = os.path.join(target_dir, os.path.basename(p))
            if os.path.exists(tgt):
                self.tgt_paths.append(tgt)
            else:
                print(f"Warning: Target image {tgt} not found for source {p}. Skipping.")
        valid_indices = [i for i, p in enumerate(self.src_paths) if os.path.join(target_dir, os.path.basename(p)) in self.tgt_paths]
        self.src_paths = [self.src_paths[i] for i in valid_indices]
        self.transform = transform or T.Compose([
            T.ToTensor(),
            T.Normalize((0.5,), (0.5,)),
        ])

    def __len__(self) -> int:
        return len(self.src_paths)

    def __getitem__(self, idx: int):
        src_img_path = self.src_paths[idx]
        tgt_img_path = os.path.join(os.path.dirname(src_img_path).replace("source", "target"), os.path.basename(src_img_path))
        src = Image.open(src_img_path).convert("L")
        tgt = Image.open(tgt_img_path).convert("L")
        return self.transform(src), self.transform(tgt)


def weights_init(m):
    """Initialize weights for convolution and batch norm layers."""
    classname = m.__class__.__name__
    if classname.find("Conv") != -1:
        nn.init.normal_(m.weight.data, 0.0, 0.02)
    elif classname.find("BatchNorm") != -1:
        nn.init.normal_(m.weight.data, 1.0, 0.02)
        nn.init.constant_(m.bias.data, 0)


class UNetGenerator(nn.Module):
    """U-Net generator architecture used in pix2pix."""

    def __init__(self, in_ch: int = 1, out_ch: int = 1, ngf: int = 64) -> None:
        super().__init__()
        self.down1 = nn.Sequential(nn.Conv2d(in_ch, ngf, 4, 2, 1, bias=False), nn.LeakyReLU(0.2))
        self.down2 = nn.Sequential(nn.Conv2d(ngf, ngf * 2, 4, 2, 1, bias=False), nn.BatchNorm2d(ngf * 2), nn.LeakyReLU(0.2))
        self.down3 = nn.Sequential(nn.Conv2d(ngf * 2, ngf * 4, 4, 2, 1, bias=False), nn.BatchNorm2d(ngf * 4), nn.LeakyReLU(0.2))
        self.down4 = nn.Sequential(nn.Conv2d(ngf * 4, ngf * 8, 4, 2, 1, bias=False), nn.BatchNorm2d(ngf * 8), nn.LeakyReLU(0.2))
        self.down5 = nn.Sequential(nn.Conv2d(ngf * 8, ngf * 8, 4, 2, 1, bias=False), nn.BatchNorm2d(ngf * 8), nn.LeakyReLU(0.2))
        self.down6 = nn.Sequential(nn.Conv2d(ngf * 8, ngf * 8, 4, 2, 1, bias=False), nn.BatchNorm2d(ngf * 8), nn.LeakyReLU(0.2))
        self.down7 = nn.Sequential(nn.Conv2d(ngf * 8, ngf * 8, 4, 2, 1, bias=False), nn.BatchNorm2d(ngf * 8), nn.LeakyReLU(0.2))
        self.down8 = nn.Sequential(nn.Conv2d(ngf * 8, ngf * 8, 4, 2, 1, bias=False), nn.ReLU(True))
        self.up1 = nn.Sequential(nn.ConvTranspose2d(ngf * 8, ngf * 8, 4, 2, 1, bias=False), nn.BatchNorm2d(ngf * 8), nn.ReLU(True))
        self.up2 = nn.Sequential(nn.ConvTranspose2d(ngf * 8 * 2, ngf * 8, 4, 2, 1, bias=False), nn.BatchNorm2d(ngf * 8), nn.ReLU(True))
        self.up3 = nn.Sequential(nn.ConvTranspose2d(ngf * 8 * 2, ngf * 8, 4, 2, 1, bias=False), nn.BatchNorm2d(ngf * 8), nn.ReLU(True))
        self.up4 = nn.Sequential(nn.ConvTranspose2d(ngf * 8 * 2, ngf * 4, 4, 2, 1, bias=False), nn.BatchNorm2d(ngf * 4), nn.ReLU(True))
        self.up5 = nn.Sequential(nn.ConvTranspose2d(ngf * 4 * 2, ngf * 2, 4, 2, 1, bias=False), nn.BatchNorm2d(ngf * 2), nn.ReLU(True))
        self.up6 = nn.Sequential(nn.ConvTranspose2d(ngf * 2 * 2, ngf, 4, 2, 1, bias=False), nn.BatchNorm2d(ngf), nn.ReLU(True))
        self.up7 = nn.Sequential(nn.ConvTranspose2d(ngf * 2, out_ch, 4, 2, 1), nn.Tanh())

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        d1 = self.down1(x)
        d2 = self.down2(d1)
        d3 = self.down3(d2)
        d4 = self.down4(d3)
        d5 = self.down5(d4)
        d6 = self.down6(d5)
        d7 = self.down7(d6)
        d8 = self.down8(d7)
        u1 = self.up1(d8)
        u2 = self.up2(torch.cat([u1, d7], 1))
        u3 = self.up3(torch.cat([u2, d6], 1))
        u4 = self.up4(torch.cat([u3, d5], 1))
        u5 = self.up5(torch.cat([u4, d4], 1))
        u6 = self.up6(torch.cat([u5, d3], 1))
        final = self.up7(torch.cat([u6, d1], 1))
        return final


class PatchDiscriminator(nn.Module):
    """PatchGAN discriminator used in pix2pix."""

    def __init__(self, in_ch: int = 2, ndf: int = 64, n_layers: int = 3) -> None:
        super().__init__()
        layers = [nn.Conv2d(in_ch, ndf, 4, 2, 1), nn.LeakyReLU(0.2, inplace=True)]
        nf_mult = 1
        for n in range(1, n_layers):
            nf_mult_prev = nf_mult
            nf_mult = min(2 ** n, 8)
            layers += [
                nn.Conv2d(ndf * nf_mult_prev, ndf * nf_mult, 4, 2, 1, bias=False),
                nn.BatchNorm2d(ndf * nf_mult),
                nn.LeakyReLU(0.2, inplace=True),
            ]
        nf_mult_prev = nf_mult
        nf_mult = min(2 ** n_layers, 8)
        layers += [
            nn.Conv2d(ndf * nf_mult_prev, ndf * nf_mult, 4, 1, 1, bias=False),
            nn.BatchNorm2d(ndf * nf_mult),
            nn.LeakyReLU(0.2, inplace=True),
        ]
        layers += [nn.Conv2d(ndf * nf_mult, 1, 4, 1, 1)]
        self.model = nn.Sequential(*layers)

    def forward(self, src: torch.Tensor, tgt: torch.Tensor) -> torch.Tensor:
        x = torch.cat([src, tgt], dim=1)
        return self.model(x)


def train(
    target_font_path: str,
    ref_font_path: str,
    chars_to_render: Dict[int, str],
    epochs: int = 200,
    batch_size: int = 4,
    lr: float = 2e-4,
    l1_lambda: float = 100.0,
    checkpoint_dir: str = "checkpoints_updated",
    source_data_dir: str = "data_updated/train/source",
    target_data_dir: str = "data_updated/train/target",
) -> None:
    """Train pix2pix on provided font pairs."""
    device = "cuda" if torch.cuda.is_available() else "cpu"
    os.makedirs(source_data_dir, exist_ok=True)
    os.makedirs(target_data_dir, exist_ok=True)
    os.makedirs(checkpoint_dir, exist_ok=True)
    for code, glyph in chars_to_render.items():
        render_char_to_png(ref_font_path, glyph, os.path.join(source_data_dir, f"{code}.png"))
        render_char_to_png(target_font_path, glyph, os.path.join(target_data_dir, f"{code}.png"))
    dataset = FontPairDataset(source_data_dir, target_data_dir)
    if len(dataset) == 0:
        print("Dataset is empty; check font paths and characters.")
        return
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True, num_workers=max(os.cpu_count() // 2, 0), pin_memory=True)
    G = UNetGenerator().to(device)
    D = PatchDiscriminator().to(device)
    G.apply(weights_init)
    D.apply(weights_init)
    opt_G = optim.Adam(G.parameters(), lr=lr, betas=(0.5, 0.999))
    opt_D = optim.Adam(D.parameters(), lr=lr, betas=(0.5, 0.999))
    criterion_GAN = nn.BCEWithLogitsLoss()
    criterion_L1 = nn.L1Loss()
    for epoch in range(1, epochs + 1):
        G.train()
        D.train()
        for i, (src, real) in enumerate(dataloader):
            src, real = src.to(device), real.to(device)
            opt_D.zero_grad()
            fake = G(src)
            real_pred = D(src, real)
            loss_D_real = criterion_GAN(real_pred, torch.ones_like(real_pred, device=device))
            fake_pred = D(src, fake.detach())
            loss_D_fake = criterion_GAN(fake_pred, torch.zeros_like(fake_pred, device=device))
            loss_D = (loss_D_real + loss_D_fake) * 0.5
            loss_D.backward()
            opt_D.step()
            opt_G.zero_grad()
            fake_again = G(src)
            fake_pred_G = D(src, fake_again)
            loss_G_GAN = criterion_GAN(fake_pred_G, torch.ones_like(fake_pred_G, device=device))
            loss_G_L1 = criterion_L1(fake_again, real) * l1_lambda
            loss_G = loss_G_GAN + loss_G_L1
            loss_G.backward()
            opt_G.step()
            if i % 50 == 0:
                print(
                    f"Epoch [{epoch:03d}/{epochs}] Batch [{i}/{len(dataloader)}] "
                    f"loss_D:{loss_D.item():.4f} loss_G:{loss_G.item():.4f} "
                    f"(GAN:{loss_G_GAN.item():.4f} L1:{loss_G_L1.item():.4f})"
                )
        if epoch % 10 == 0 or epoch == epochs:
            torch.save(G.state_dict(), os.path.join(checkpoint_dir, f"G_epoch{epoch:03d}.pth"))
            torch.save(D.state_dict(), os.path.join(checkpoint_dir, f"D_epoch{epoch:03d}.pth"))


def inference(
    gen_checkpoint: str,
    chars_to_generate: Dict[int, str],
    ref_font_path: str,
    out_dir: str,
    batch_size: int = 4,
) -> None:
    """Generate characters using a trained generator."""
    device = "cuda" if torch.cuda.is_available() else "cpu"
    G = UNetGenerator().to(device)
    G.load_state_dict(torch.load(gen_checkpoint, map_location=device))
    G.eval()
    os.makedirs(out_dir, exist_ok=True)
    transform = T.Compose([T.ToTensor(), T.Normalize((0.5,), (0.5,))])
    char_list = list(chars_to_generate.items())
    for i in range(0, len(char_list), batch_size):
        batch_items = char_list[i : i + batch_size]
        tensors = []
        filenames = []
        for code, glyph in batch_items:
            buf = io.BytesIO()
            render_char_to_png(ref_font_path, glyph, buf)
            img = Image.open(buf).convert("L")
            tensors.append(transform(img))
            filenames.append(os.path.join(out_dir, f"{code}.png"))
        if not tensors:
            continue
        x = torch.stack(tensors).to(device)
        with torch.no_grad():
            y_batch = G(x).cpu()
        for j in range(y_batch.size(0)):
            y = y_batch[j].squeeze(0)
            out_np = ((y * 0.5 + 0.5) * 255).clamp(0, 255).numpy().astype("uint8")
            if out_np.ndim == 3 and out_np.shape[0] == 1:
                out_np = out_np[0]
            Image.fromarray(out_np).save(filenames[j])
        print(
            f"  Generated batch {i // batch_size + 1}/{(len(char_list) + batch_size - 1) // batch_size}"
        )


if __name__ == "__main__":
    TARGET_FONT_PATH = "path/to/GD-HighwayGothicJA.otf"
    REFERENCE_FONT_PATH = "path/to/reference_font.otf"
    OUTPUT_DIR_TRAIN = "data_updated"
    CHECKPOINT_DIR = "checkpoints_gd_highwaygothic"
    GENERATED_FONT_DIR = "output_gd_highwaygothic"
    NUM_EPOCHS = 200
    BATCH_SIZE = 4
    LEARNING_RATE = 0.0002
    L1_LAMBDA = 100
    common_chars_for_training = {
        ord("あ"): "あ",
        ord("い"): "い",
        ord("う"): "う",
        ord("え"): "え",
        ord("お"): "お",
        ord("カ"): "カ",
        ord("キ"): "キ",
        ord("ク"): "ク",
        ord("ケ"): "ケ",
        ord("コ"): "コ",
        ord("道"): "道",
        ord("路"): "路",
        ord("ゴ"): "ゴ",
        ord("A"): "A",
        ord("B"): "B",
    }
    if not common_chars_for_training:
        print("Training character list is empty.")
        raise SystemExit
    if not os.path.exists(TARGET_FONT_PATH):
        print(f"Target font not found: {TARGET_FONT_PATH}")
        raise SystemExit
    if not os.path.exists(REFERENCE_FONT_PATH):
        print(f"Reference font not found: {REFERENCE_FONT_PATH}")
        raise SystemExit
    train(
        target_font_path=TARGET_FONT_PATH,
        ref_font_path=REFERENCE_FONT_PATH,
        chars_to_render=common_chars_for_training,
        epochs=NUM_EPOCHS,
        batch_size=BATCH_SIZE,
        lr=LEARNING_RATE,
        l1_lambda=L1_LAMBDA,
        checkpoint_dir=CHECKPOINT_DIR,
        source_data_dir=os.path.join(OUTPUT_DIR_TRAIN, "train", "source"),
        target_data_dir=os.path.join(OUTPUT_DIR_TRAIN, "train", "target"),
    )
    missing_chars_to_generate = {
        ord("🎨"): "🎨",
        ord("琉"): "琉",
        ord("球"): "球",
    }
    latest_checkpoint = os.path.join(CHECKPOINT_DIR, f"G_epoch{NUM_EPOCHS:03d}.pth")
    if os.path.exists(latest_checkpoint) and missing_chars_to_generate:
        inference(
            gen_checkpoint=latest_checkpoint,
            chars_to_generate=missing_chars_to_generate,
            ref_font_path=REFERENCE_FONT_PATH,
            out_dir=GENERATED_FONT_DIR,
            batch_size=BATCH_SIZE,
        )
