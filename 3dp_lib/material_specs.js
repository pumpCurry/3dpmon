"use strict";

export const MATERIAL_SPECS = {
  PLA:  { printTemp: [190, 220], bedTemp: [0, 60],  density: 1.24 },
  PETG: { printTemp: [220, 250], bedTemp: [60, 80], density: 1.27 },
  ABS:  { printTemp: [230, 260], bedTemp: [80, 110], density: 1.04 },
  TPU:  { printTemp: [210, 230], bedTemp: [0, 60],  density: 1.20 }
};
