// Animated page background using ShaderGradient (https://github.com/ruucm/shadergradient, MIT).
// It's a React + react-three-fiber component; React/three are loaded from the CDN via the import map
// in index.html (no build step). If anything fails to load, the static light.webp background stays.
// Settings come from a shadergradient.co design; the theme tint in styles.css sits on top for readability.
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { ShaderGradientCanvas, ShaderGradient } from "@shadergradient/react";

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

createRoot(document.querySelector("#bg-gradient")).render(
  h(ShaderGradientCanvas, { style: { position: "absolute", inset: 0 }, fov: 60, pixelDensity: 1, lazyLoad: false },
    h(ShaderGradient, {
      control: "props",
      animate: reduce ? "off" : "on",
      brightness: 1,
      cAzimuthAngle: 180,
      cDistance: 3.61,
      cPolarAngle: 90,
      cameraZoom: 1,
      color1: "#009b00",
      color2: "#00bdb7",
      color3: "#adb300",
      envPreset: "lobby",
      grain: "on",
      lightType: "3d",
      positionX: -1.4,
      positionY: 0,
      positionZ: 0,
      range: "disabled",
      rangeEnd: 40,
      rangeStart: 0,
      reflection: 0.1,
      rotationX: 0,
      rotationY: 10,
      rotationZ: 50,
      shader: "defaults",
      type: "plane",
      uAmplitude: 1,
      uDensity: 1.3,
      uFrequency: 5.5,
      uSpeed: 0.1,
      uStrength: 4,
      uTime: 0,
      wireframe: false,
    })));
