export const SPRITE_COLUMNS = 3;
export const SPRITE_ROWS = 2;
export const SPRITE_FRAMES = 5;

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function spriteSheetCellRect(
  imageWidth: number,
  imageHeight: number,
  index: number,
  columns = SPRITE_COLUMNS,
  rows = SPRITE_ROWS
): CellRect {
  const column = index % columns;
  const row = Math.floor(index / columns);
  const cellWidth = imageWidth / columns;
  const cellHeight = imageHeight / rows;

  const x = Math.round(column * cellWidth);
  const y = Math.round(row * cellHeight);
  const right = Math.round((column + 1) * cellWidth);
  const bottom = Math.round((row + 1) * cellHeight);

  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = dataUrl;
  if (typeof image.decode === "function") {
    await image.decode();
  } else {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图片加载失败"));
    });
  }
  return image;
}

export async function sliceSpriteSheet(
  dataUrl: string,
  columns = SPRITE_COLUMNS,
  rows = SPRITE_ROWS,
  frames = SPRITE_FRAMES
): Promise<string[]> {
  const image = await loadImage(dataUrl);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width === 0 || height === 0) throw new Error("动作序列图尺寸无效");

  const cells: string[] = [];
  for (let index = 0; index < frames; index++) {
    const rect = spriteSheetCellRect(width, height, index, columns, rows);
    const size = Math.min(rect.width, rect.height);
    const sourceX = rect.x + (rect.width - size) / 2;
    const sourceY = rect.y + (rect.height - size) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建 Canvas 上下文");
    context.drawImage(image, sourceX, sourceY, size, size, 0, 0, size, size);
    cells.push(canvas.toDataURL("image/png"));
  }

  return cells;
}
