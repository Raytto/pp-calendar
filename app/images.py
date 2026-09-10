"""Bounded decoding and metadata-free WebP images for event attachments."""
from dataclasses import dataclass
from io import BytesIO

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener

register_heif_opener()
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_EVENT_IMAGES = 12
MAX_PIXELS = 50_000_000  # Accommodates 48 MP phone photos before downsampling.
MAX_STORED_BYTES = 8 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


@dataclass
class PreparedImage:
    width: int
    height: int
    image: bytes
    thumbnail: bytes


def encode_webp(image: Image.Image, quality: int) -> bytes:
    result = BytesIO()
    image.save(result, format="WEBP", quality=quality, method=4)
    return result.getvalue()


def prepare_image(content: bytes) -> PreparedImage:
    if not content or len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "图片为空或超过 20 MiB")
    try:
        with Image.open(BytesIO(content), formats=["JPEG", "PNG", "WEBP", "HEIF"]) as source:
            if source.width * source.height > MAX_PIXELS:
                raise HTTPException(413, "图片不能超过 5000 万像素")
            if getattr(source, "n_frames", 1) > 1:
                raise HTTPException(415, "请上传静态图片；多帧图片请先导出其中一张")
            source.load()
            upright = ImageOps.exif_transpose(source)
            upright.thumbnail((2560, 2560), Image.Resampling.LANCZOS)
            # A fresh image drops EXIF/GPS, XMP and other uploaded metadata.
            mode = "RGBA" if "A" in upright.getbands() or "transparency" in upright.info else "RGB"
            clean = Image.new(mode, upright.size)
            clean.paste(upright.convert(mode))
            full = encode_webp(clean, 90)
            if len(full) > MAX_STORED_BYTES:
                raise HTTPException(413, "图片转换后仍然过大，请缩小后重试")
            width, height = clean.size
            clean.thumbnail((320, 320), Image.Resampling.LANCZOS)
            return PreparedImage(width, height, full, encode_webp(clean, 78))
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as error:
        raise HTTPException(415, "无法读取图片，请上传有效的 JPEG、PNG、WebP 或 HEIC 图片") from error
    except Image.DecompressionBombError as error:
        raise HTTPException(413, "图片像素过大") from error
