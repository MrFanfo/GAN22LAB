import { useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { HOME_ORIENTATION } from "../lib/gyro";
import { normalizeFacelets24, splitFacelets24 } from "../lib/cubeState2x2";

type VirtualCube2x2Props = {
  targetQuaternionRef: MutableRefObject<THREE.Quaternion | null>;
  gyroEnabled: boolean;
  facelets24: string;
  moveAlg: string;
};

type Face = "U" | "R" | "F" | "D" | "L" | "B";

type StickerBinding = {
  face: Face;
  index: number;
  material: THREE.MeshBasicMaterial;
};

const STICKER_COLORS: Record<Face, number> = {
  U: 0xf8fafc,
  R: 0xef4444,
  F: 0x22c55e,
  D: 0xfacc15,
  L: 0xf97316,
  B: 0x3b82f6,
};

function faceletPosition(face: Face, index: number): THREE.Vector3 {
  // Facelet order is fixed as U, R, F, D, L, B; each face is laid out as:
  // 0 1
  // 2 3
  // Positions below describe that layout as viewed from outside each face.
  const col = index % 2;
  const row = Math.floor(index / 2);
  const a = col === 0 ? -0.52 : 0.52;
  const b = row === 0 ? 0.52 : -0.52;
  const d = 1.035;

  switch (face) {
    case "F": return new THREE.Vector3(a, b, d);
    case "B": return new THREE.Vector3(-a, b, -d);
    case "U": return new THREE.Vector3(a, d, -b);
    case "D": return new THREE.Vector3(a, -d, b);
    case "R": return new THREE.Vector3(d, b, -a);
    case "L": return new THREE.Vector3(-d, b, a);
  }
}

function faceletRotation(face: Face): THREE.Euler {
  switch (face) {
    case "F": return new THREE.Euler(0, 0, 0);
    case "B": return new THREE.Euler(0, Math.PI, 0);
    case "U": return new THREE.Euler(-Math.PI / 2, 0, 0);
    case "D": return new THREE.Euler(Math.PI / 2, 0, 0);
    case "R": return new THREE.Euler(0, Math.PI / 2, 0);
    case "L": return new THREE.Euler(0, -Math.PI / 2, 0);
  }
}

function buildCubeObject(stickerBindings: StickerBinding[]): THREE.Group {
  const cube = new THREE.Group();
  cube.quaternion.copy(HOME_ORIENTATION);

  const cubieGeometry = new THREE.BoxGeometry(0.98, 0.98, 0.98);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x05070d,
    roughness: 0.72,
    metalness: 0.08,
  });
  for (const x of [-0.52, 0.52]) {
    for (const y of [-0.52, 0.52]) {
      for (const z of [-0.52, 0.52]) {
        const cubie = new THREE.Mesh(cubieGeometry, bodyMaterial);
        cubie.position.set(x, y, z);
        cube.add(cubie);
      }
    }
  }

  const stickerGeometry = new THREE.PlaneGeometry(0.82, 0.82);
  for (const face of ["U", "R", "F", "D", "L", "B"] as Face[]) {
    for (let index = 0; index < 4; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: STICKER_COLORS[face],
        side: THREE.DoubleSide,
      });
      const sticker = new THREE.Mesh(stickerGeometry, material);
      sticker.position.copy(faceletPosition(face, index));
      sticker.rotation.copy(faceletRotation(face));
      stickerBindings.push({ face, index, material });
      cube.add(sticker);
    }
  }

  return cube;
}

function updateStickerColors(stickerBindings: StickerBinding[], facelets24: string) {
  const faces = splitFacelets24(normalizeFacelets24(facelets24));
  for (const binding of stickerBindings) {
    const stickerFace = faces[binding.face][binding.index] as Face | undefined;
    binding.material.color.setHex(STICKER_COLORS[stickerFace ?? binding.face]);
  }
}

export function VirtualCube2x2({
  targetQuaternionRef,
  gyroEnabled,
  facelets24,
}: VirtualCube2x2Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const cubeRef = useRef<THREE.Group | null>(null);
  const stickerBindingsRef = useRef<StickerBinding[]>([]);
  const frameRef = useRef<number | null>(null);
  const fallbackRef = useRef(HOME_ORIENTATION.clone());
  const manualQuaternionRef = useRef(new THREE.Quaternion());
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const initialFaceletsRef = useRef(facelets24);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0, 5.4);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.className = "three-cube-canvas";
    host.replaceChildren(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 1.8);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(3, 4, 5);
    scene.add(ambient, key);

    const stickerBindings: StickerBinding[] = [];
    const cube = buildCubeObject(stickerBindings);
    updateStickerColors(stickerBindings, initialFaceletsRef.current);
    scene.add(cube);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    cubeRef.current = cube;
    stickerBindingsRef.current = stickerBindings;

    const resize = () => {
      const width = Math.max(260, host.clientWidth);
      const height = Math.max(300, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    resize();

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    const applyDrag = (dx: number, dy: number) => {
      const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * 0.008);
      const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * 0.008);
      manualQuaternionRef.current
        .premultiply(yaw)
        .premultiply(pitch)
        .normalize();
    };

    const onPointerDown = (event: PointerEvent) => {
      host.setPointerCapture(event.pointerId);
      dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      host.classList.add("is-dragging");
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      applyDrag(event.clientX - drag.x, event.clientY - drag.y);
      dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    };

    const onPointerEnd = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      host.classList.remove("is-dragging");
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    };

    const onDoubleClick = () => {
      manualQuaternionRef.current.identity();
    };

    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerEnd);
    host.addEventListener("pointercancel", onPointerEnd);
    host.addEventListener("dblclick", onDoubleClick);

    const tick = () => {
      const baseTarget = gyroEnabled && targetQuaternionRef.current
        ? targetQuaternionRef.current
        : fallbackRef.current;
      const target = manualQuaternionRef.current.clone().multiply(baseTarget).normalize();
      cube.quaternion.slerp(target, 0.22);
      renderer.render(scene, camera);
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => {
      resizeObserver.disconnect();
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerEnd);
      host.removeEventListener("pointercancel", onPointerEnd);
      host.removeEventListener("dblclick", onDoubleClick);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      });
      renderer.dispose();
      host.replaceChildren();
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      cubeRef.current = null;
      stickerBindingsRef.current = [];
    };
  }, [gyroEnabled, targetQuaternionRef]);

  useEffect(() => {
    updateStickerColors(stickerBindingsRef.current, facelets24);
  }, [facelets24]);

  return (
    <div className="twisty-gyro-shell">
      <div ref={hostRef} className="twisty-gyro-host" aria-label="Live 3D virtual 2x2 cube" />
      <div className="twisty-logical-state">
        <span>Logical 2x2 state</span>
        <strong className="mono">{normalizeFacelets24(facelets24)}</strong>
      </div>
    </div>
  );
}
