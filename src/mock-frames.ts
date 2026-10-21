import type { PetAction, PetSpecies } from "./types";

export function getMockFrames(species: PetSpecies, action: PetAction): string[] {
  const frames: string[] = [];
  for (let i = 0; i < 5; i++) {
    const isCat = species === "cat";
    const headColor = isCat ? "#ffb040" : "#d0a070";
    const bodyColor = isCat ? "#ffa030" : "#c09060";
    const earColor = isCat ? "#ffb040" : "#8a5a3a";
    const innerEarColor = "#ff8090";

    let yOffset = 0;
    let scaleY = 1;
    let scaleX = 1;
    let eyesClosed = false;
    let mouthOpen = false;
    let tailAngle = 0;
    let legOffset1 = 0;
    let legOffset2 = 0;
    let rotate = 0;

    if (action === "idle") {
      yOffset = i === 1 || i === 3 ? 2 : 0;
      eyesClosed = i === 2;
    } else if (action === "sit") {
      yOffset = 5;
      scaleY = 0.94;
      tailAngle = Math.sin((i * Math.PI) / 2) * 12;
    } else if (action === "sleep") {
      yOffset = 8;
      scaleY = 0.88;
      eyesClosed = true;
    } else if (action === "happy") {
      yOffset = i % 2 === 0 ? -8 : 3;
      scaleY = i % 2 === 0 ? 1.05 : 0.95;
      rotate = i % 2 === 0 ? -3 : 3;
      mouthOpen = true;
    } else if (action === "walk") {
      yOffset = i % 2 === 0 ? -2 : 2;
      legOffset1 = Math.sin((i * Math.PI) / 2) * 9;
      legOffset2 = -legOffset1;
      tailAngle = Math.sin((i * Math.PI) / 2) * 18;
    } else if (action === "jump") {
      yOffset = i === 0 || i === 4 ? -2 : -24;
      scaleY = i === 0 || i === 4 ? 0.95 : 1.1;
      legOffset1 = i === 2 ? 8 : -2;
      legOffset2 = i === 2 ? 8 : -2;
    }

    const eyeElement = eyesClosed
      ? `<path d="M 134,106 Q 140,111 146,106 M 174,106 Q 180,111 186,106" stroke="#3c291f" stroke-width="3" stroke-linecap="round" fill="none" />`
      : `<circle cx="140" cy="106" r="4.5" fill="#3c291f" />
         <circle cx="180" cy="106" r="4.5" fill="#3c291f" />
         <circle cx="138" cy="103" r="1.5" fill="#fff" />
         <circle cx="178" cy="103" r="1.5" fill="#fff" />`;

    const mouthElement = mouthOpen
      ? `<path d="M 155,114 Q 160,125 165,114 Z" fill="#ff6678" stroke="#3c291f" stroke-width="2.5" />`
      : `<path d="M 156,113 Q 160,116 164,113 Q 160,110 156,113" stroke="#3c291f" stroke-width="2.5" stroke-linecap="round" fill="none" />`;

    const cheeks = `<circle cx="130" cy="112" r="6" fill="#ff6678" opacity="0.45" />
                    <circle cx="190" cy="112" r="6" fill="#ff6678" opacity="0.45" />`;

    const ears = isCat
      ? `<polygon points="120,95 108,60 142,82" fill="${earColor}" stroke="#3c291f" stroke-width="3" stroke-linejoin="round" />
         <polygon points="123,92 114,68 138,82" fill="${innerEarColor}" />
         <polygon points="200,95 212,60 178,82" fill="${earColor}" stroke="#3c291f" stroke-width="3" stroke-linejoin="round" />
         <polygon points="197,92 206,68 182,82" fill="${innerEarColor}" />`
      : `<path d="M 120,80 C 102,80 96,116 112,126 C 124,126 130,102 124,80 Z" fill="${earColor}" stroke="#3c291f" stroke-width="3" stroke-linejoin="round" />
         <path d="M 200,80 C 218,80 224,116 208,126 C 196,126 190,102 196,80 Z" fill="${earColor}" stroke="#3c291f" stroke-width="3" stroke-linejoin="round" />`;

    const tailX = isCat ? 110 : 120;
    const tailPath = isCat
      ? `<path d="M 125,170 Q ${tailX - 25 + tailAngle},160 ${tailX - 15 + tailAngle},125" stroke="${bodyColor}" stroke-width="11" stroke-linecap="round" fill="none" />
         <path d="M 125,170 Q ${tailX - 25 + tailAngle},160 ${tailX - 15 + tailAngle},125" stroke="#3c291f" stroke-width="15" stroke-linecap="round" fill="none" style="z-index:-1" />`
      : `<path d="M 125,170 Q ${tailX - 10 + tailAngle},165 ${tailX + tailAngle},150" stroke="${earColor}" stroke-width="9" stroke-linecap="round" fill="none" />`;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" width="320" height="320">
        <g transform="translate(0, ${yOffset}) rotate(${rotate} 160 160)">
          <ellipse cx="160" cy="225" rx="${60 * scaleX}" ry="12" fill="rgba(60, 41, 31, 0.15)" />
          ${isCat ? tailPath : ""}
          <ellipse cx="160" cy="182" rx="${46 * scaleX}" ry="${38 * scaleY}" fill="${bodyColor}" stroke="#3c291f" stroke-width="3" />
          <rect x="135" y="${192 + legOffset1}" width="16" height="30" rx="8" fill="${bodyColor}" stroke="#3c291f" stroke-width="3" />
          <rect x="169" y="${192 + legOffset2}" width="16" height="30" rx="8" fill="${bodyColor}" stroke="#3c291f" stroke-width="3" />
          ${ears}
          <ellipse cx="160" cy="116" rx="${48 * scaleX}" ry="${42 * scaleY}" fill="${headColor}" stroke="#3c291f" stroke-width="3" />
          ${eyeElement}
          ${cheeks}
          ${
            !isCat
              ? `<ellipse cx="160" cy="116" rx="14" ry="10" fill="#fff" stroke="#3c291f" stroke-width="2" />
                 <ellipse cx="160" cy="111" rx="6" ry="4" fill="#3c291f" />`
              : ""
          }
          ${mouthElement}
          ${
            isCat
              ? `
            <path d="M 112,114 L 98,112 M 112,118 L 96,119 M 208,114 L 222,112 M 208,118 L 224,119" stroke="#3c291f" stroke-width="2" stroke-linecap="round" />
          `
              : ""
          }
        </g>
      </svg>
    `;
    frames.push("data:image/svg+xml;utf8," + encodeURIComponent(svg.trim()));
  }
  return frames;
}
