/**
 * Network3D.js — the WebGL view of the network.
 *
 * Two rules keep this cheap:
 *   1. Geometry is memoised and only rebuilt when its endpoints move, so the
 *      renderer never allocates (and leaks) a mesh per frame.
 *   2. Anything that moves every frame is driven from `useFrame` by mutating
 *      object transforms directly. Nothing here calls setState per frame.
 */

import React, { useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Billboard, OrbitControls, Text } from '@react-three/drei';
import * as THREE from 'three';
import {
  COLORS,
  CORRECTNESS_STYLES,
  LINK_DECORATIONS,
  ROUTER_DECORATIONS,
  ROUTE_ACCENTS,
  SCENE,
  messageStyle,
} from './config';
import { compareIds, formatCell } from './DvrAlgorithm';

const UP = new THREE.Vector3(0, 1, 0);

/** Order-independent key for the edge between two routers. */
const edgeKey = (a, b) => [a, b].sort(compareIds).join('|');

/** Position, orientation and length of the segment between two points. */
function useSegment(sx, sy, sz, tx, ty, tz) {
  return useMemo(() => {
    const start = new THREE.Vector3(sx, sy, sz);
    const end = new THREE.Vector3(tx, ty, tz);
    const direction = new THREE.Vector3().subVectors(end, start);
    const length = direction.length();
    const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const quaternion = new THREE.Quaternion();
    if (length > SCENE.link.minLength) {
      quaternion.setFromUnitVectors(UP, direction.clone().divideScalar(length));
    }
    return { start, end, midpoint, quaternion, length };
  }, [sx, sy, sz, tx, ty, tz]);
}

/* ------------------------------------------------------------------ *
 * Routing table panel
 * ------------------------------------------------------------------ */

function RoutingTablePanel({
  routerId,
  table,
  columns,
  rowLabel,
  correctness,
  infinityCost,
  offset,
}) {
  const rows = useMemo(
    () => Object.entries(table || {}).sort(([a], [b]) => compareIds(a, b)),
    [table]
  );
  const { rowHeight, headerHeight, footerPadding, columnWidth, minColumns, rowTintInset } =
    SCENE.table;

  // The row's own key is always the first column; the protocol supplies the
  // rest, and names the first one when it is not a destination.
  const allColumns = useMemo(
    () => [{ key: null, label: rowLabel || 'Destination', format: 'text' }, ...(columns || [])],
    [columns, rowLabel]
  );
  const width = columnWidth * Math.max(minColumns, allColumns.length);
  const columnX = (index) => -width / 2 + columnWidth * (index + 0.5);

  const height = headerHeight + rows.length * rowHeight + footerPadding;
  const top = height / 2;
  /** Baseline of row `index`; the text hangs down from here. */
  const rowY = (index) => top - headerHeight - index * rowHeight;

  return (
    <Billboard position={offset}>
      <mesh>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          color={COLORS.panelSurface}
          transparent
          opacity={SCENE.table.surfaceOpacity}
          side={THREE.DoubleSide}
        />
      </mesh>

      <Text
        position={[0, top - 0.32, 0.02]}
        fontSize={SCENE.table.titleSize}
        color={COLORS.panelText}
        anchorX="center"
        anchorY="top"
      >
        {`Router ${routerId}`}
      </Text>

      {/* Keyed by position: two columns may legitimately read the same field. */}
      {allColumns.map((column, index) => (
        <Text
          key={index}
          position={[columnX(index), top - 0.78, 0.02]}
          fontSize={SCENE.table.headerSize}
          color={COLORS.panelMuted}
          anchorX="center"
          anchorY="top"
        >
          {column.label}
        </Text>
      ))}

      {/* Correctness tints sit between the panel surface and the text, so a
          wrong row reads at a glance without the numbers losing contrast. */}
      {rows.map(([destination], index) => {
        const style = CORRECTNESS_STYLES[correctness && correctness[destination]];
        if (!style || !style.sceneTint) return null;
        return (
          <mesh
            key={`tint-${destination}`}
            position={[0, rowY(index) - SCENE.table.rowSize / 2, 0.01]}
          >
            <planeGeometry args={[width - rowTintInset * 2, rowHeight]} />
            <meshBasicMaterial
              color={COLORS[style.colorKey]}
              transparent
              opacity={style.sceneTint}
              side={THREE.DoubleSide}
            />
          </mesh>
        );
      })}

      {/* A route the protocol accented — one chosen by policy rather than by
          length or cost — gets an edge bar rather than a second wash, so it
          reads on top of whatever the correctness tint is already saying. */}
      {rows.map(([destination, route], index) => {
        const accent = ROUTE_ACCENTS[route.accent];
        if (!accent) return null;
        return (
          <mesh
            key={`accent-${destination}`}
            position={[
              -width / 2 + rowTintInset,
              rowY(index) - SCENE.table.rowSize / 2,
              0.015,
            ]}
          >
            <planeGeometry args={[SCENE.table.accentWidth, rowHeight]} />
            <meshBasicMaterial
              color={COLORS[accent.colorKey]}
              side={THREE.DoubleSide}
            />
          </mesh>
        );
      })}

      {rows.map(([destination, route], index) => {
        const y = rowY(index);
        return allColumns.map((column, columnIndex) => (
          <Text
            key={`${destination}-${columnIndex}`}
            position={[columnX(columnIndex), y, 0.02]}
            fontSize={SCENE.table.rowSize}
            color={COLORS.panelText}
            anchorX="center"
            anchorY="top"
          >
            {column.key === null
              ? destination
              : formatCell(column.format, route[column.key], infinityCost, route)}
          </Text>
        ));
      })}
    </Billboard>
  );
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

function Router({
  id,
  position,
  isSelected,
  isDown,
  decoration,
  onSelect,
  table,
  columns,
  rowLabel,
  correctness,
  infinityCost,
  peers,
}) {
  const [hovered, setHovered] = useState(false);

  // Park the table in whichever direction has the most empty space around it.
  const panelOffset = useMemo(() => {
    const { offsets, offsetDistance } = SCENE.table;
    const self = new THREE.Vector3(...position);
    const others = Object.entries(peers)
      .filter(([peerId]) => peerId !== id)
      .map(([, peer]) => new THREE.Vector3(peer.x, peer.y, peer.z));

    let best = offsets[0];
    let bestClearance = -Infinity;
    offsets.forEach((offset) => {
      const candidate = new THREE.Vector3(...offset)
        .multiplyScalar(offsetDistance)
        .add(self);
      const clearance = others.reduce(
        (min, other) => Math.min(min, candidate.distanceTo(other)),
        Infinity
      );
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = offset;
      }
    });
    return new THREE.Vector3(...best).multiplyScalar(offsetDistance).toArray();
  }, [id, peers, position]);

  /**
   * Precedence: down > selected > decoration > hovered > idle.
   *
   * Decorations tint, but they never take priority over the two states the
   * user can act on — a root bridge that is switched off must still read as
   * off, and one the user just clicked must still read as selected.
   */
  const style = ROUTER_DECORATIONS[decoration];
  let color = COLORS.routerIdle;
  if (isDown) color = COLORS.routerDown;
  else if (isSelected) color = COLORS.routerSelected;
  else if (style) color = COLORS[style.colorKey];
  else if (hovered) color = COLORS.routerHovered;

  const label = isDown ? `${id} (down)` : `${id}${style ? style.suffix : ''}`;
  const { size, labelSize, labelOutline, labelLift, downOpacity, idleOpacity } = SCENE.router;

  return (
    <group position={position}>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onSelect(id);
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
      >
        <boxGeometry args={[size, size, size]} />
        <meshStandardMaterial
          color={color}
          metalness={0.1}
          roughness={0.6}
          transparent
          opacity={isDown ? downOpacity : idleOpacity}
        />
      </mesh>

      {/* One billboarded label beats six meshes glued to the cube faces. */}
      <Billboard position={[0, labelLift, 0]}>
        <Text
          fontSize={labelSize}
          color={isDown ? COLORS.textSecondary : COLORS.label}
          anchorX="center"
          anchorY="middle"
          outlineWidth={labelOutline}
          outlineColor={COLORS.labelOutline}
        >
          {label}
        </Text>
      </Billboard>

      {isSelected && table && (
        <RoutingTablePanel
          routerId={id}
          table={table}
          columns={columns}
          rowLabel={rowLabel}
          correctness={correctness}
          infinityCost={infinityCost}
          offset={panelOffset}
        />
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Link
 * ------------------------------------------------------------------ */

function Link({ sx, sy, sz, tx, ty, tz, cost, decoration, isHighlighted, isDimmed }) {
  const materialRef = useRef();
  const [hovered, setHovered] = useState(false);
  const { midpoint, quaternion, length } = useSegment(sx, sy, sz, tx, ty, tz);

  const { radius, radialSegments, labelSize, labelOutline, labelLift } = SCENE.link;
  // Precedence: path highlight > decoration > hovered > idle. A blocked link
  // the user has traced a path through must still read as on the path.
  const style = !isHighlighted && !isDimmed ? LINK_DECORATIONS[decoration] : undefined;
  let baseOpacity = isHighlighted ? SCENE.link.highlightOpacity : SCENE.link.idleOpacity;
  if (style) baseOpacity = style.opacity;

  useFrame(({ clock }) => {
    const material = materialRef.current;
    if (!material) return;
    const wave = Math.sin(clock.getElapsedTime() * SCENE.link.pulseSpeed);
    if (isHighlighted) {
      material.opacity = baseOpacity;
      material.emissiveIntensity = 0.6 + wave * 0.3;
    } else if (style) {
      // Decorated links hold still: the pulse is how an ordinary link says
      // "nothing to see here", and a blocked or on-tree link is a statement.
      material.opacity = baseOpacity;
      material.emissiveIntensity = hovered ? 0.35 : 0.1;
    } else {
      material.opacity = isDimmed ? 0.25 : baseOpacity + wave * SCENE.link.pulseDepth * 0.5;
      material.emissiveIntensity = hovered ? 0.35 : 0.1;
    }
  });

  if (length <= SCENE.link.minLength) return null;

  let color = COLORS.link;
  if (isDimmed) color = COLORS.linkDown;
  else if (isHighlighted) color = COLORS.linkHighlighted;
  else if (style) color = COLORS[style.colorKey];
  else if (hovered) color = COLORS.linkHovered;

  return (
    <group>
      <mesh
        position={midpoint}
        quaternion={quaternion}
        onPointerOver={(event) => {
          event.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
      >
        <cylinderGeometry args={[radius, radius, length, radialSegments]} />
        <meshStandardMaterial
          ref={materialRef}
          color={color}
          emissive={color}
          emissiveIntensity={0.1}
          transparent
          opacity={baseOpacity}
        />
      </mesh>

      <Billboard position={[midpoint.x, midpoint.y + labelLift, midpoint.z]}>
        <Text
          fontSize={labelSize}
          color={isHighlighted ? COLORS.linkHighlighted : COLORS.label}
          anchorX="center"
          anchorY="middle"
          outlineWidth={labelOutline}
          outlineColor={COLORS.labelOutline}
        >
          {String(cost)}
        </Text>
      </Billboard>
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Update packet
 * ------------------------------------------------------------------ */

function Packet({ sx, sy, sz, tx, ty, tz, kind, label, startedAt, duration }) {
  const groupRef = useRef();
  const { start, end } = useSegment(sx, sy, sz, tx, ty, tz);

  // Colour and caption come from the message's own `kind`, so a DUAL query and
  // its reply are told apart without the scene knowing DUAL exists.
  const style = messageStyle(kind);
  const color = COLORS[style.colorKey];
  const caption = label || style.label;

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    const elapsed = performance.now() - startedAt;
    const progress = duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 1;

    group.position.lerpVectors(start, end, progress);
    const pulse =
      1 + Math.sin(progress * Math.PI * SCENE.packet.pulseCycles) * SCENE.packet.pulseDepth;
    group.scale.setScalar(pulse);
    // `startedAt` may be in the future: timer mode spaces a step's messages out
    // in proportion to the simulated moments they were sent, and a packet must
    // not sit visibly on its source router waiting for its turn.
    group.visible = elapsed >= 0 && progress < 1;
  });

  return (
    <group ref={groupRef}>
      <mesh>
        <sphereGeometry args={[SCENE.packet.radius, SCENE.packet.segments, SCENE.packet.segments]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.6}
          transparent
          opacity={0.65}
        />
      </mesh>
      <Billboard>
        <Text
          fontSize={SCENE.packet.labelSize}
          color={COLORS.labelOutline}
          anchorX="center"
          anchorY="middle"
          outlineWidth={SCENE.packet.labelOutline}
          outlineColor={color}
        >
          {caption}
        </Text>
      </Billboard>
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Path pulse
 * ------------------------------------------------------------------ */

function PathPulse({ path, routers }) {
  const meshRef = useRef();

  // Skip any hop whose router has since been deleted rather than crashing.
  const points = useMemo(
    () =>
      path
        .map((id) => routers[id])
        .filter(Boolean)
        .map((router) => new THREE.Vector3(router.x, router.y, router.z)),
    [path, routers]
  );

  const segments = useMemo(() => {
    const list = [];
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      const length = points[i].distanceTo(points[i - 1]);
      list.push({ from: points[i - 1], to: points[i], length, offset: total });
      total += length;
    }
    return { list, total };
  }, [points]);

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh || segments.total <= 0) return;

    const progress = (clock.getElapsedTime() % SCENE.pathPulse.loopSeconds) /
      SCENE.pathPulse.loopSeconds;
    const target = progress * segments.total;

    const segment =
      segments.list.find((item) => target <= item.offset + item.length) ||
      segments.list[segments.list.length - 1];
    const local = segment.length > 0 ? (target - segment.offset) / segment.length : 0;

    mesh.position.lerpVectors(segment.from, segment.to, Math.min(1, Math.max(0, local)));
    mesh.scale.setScalar(
      1 + Math.sin(progress * Math.PI * SCENE.pathPulse.pulseCycles) * SCENE.pathPulse.pulseDepth
    );
  });

  if (points.length < 2) return null;

  return (
    <mesh ref={meshRef}>
      <sphereGeometry
        args={[SCENE.pathPulse.radius, SCENE.pathPulse.segments, SCENE.pathPulse.segments]}
      />
      <meshStandardMaterial
        color={COLORS.pathPulse}
        emissive={COLORS.pathPulse}
        emissiveIntensity={1.5}
        transparent
        opacity={0.9}
      />
    </mesh>
  );
}

/* ------------------------------------------------------------------ *
 * Scene furniture
 * ------------------------------------------------------------------ */

/** A grid that grows to cover whatever the topology needs. */
function AdaptiveGrid({ bounds }) {
  const { cellSize, minExtent, maxExtent, padding } = SCENE.grid;
  const reach = Math.max(
    Math.abs(bounds.min.x),
    Math.abs(bounds.max.x),
    Math.abs(bounds.min.z),
    Math.abs(bounds.max.z)
  );
  const extent = Math.min(
    maxExtent,
    Math.max(minExtent, Math.ceil((reach * 2 + padding) / cellSize) * cellSize)
  );
  return (
    <gridHelper
      args={[extent, Math.round(extent / cellSize), COLORS.gridMajor, COLORS.gridMinor]}
      position={[0, bounds.min.y - 1, 0]}
    />
  );
}

/** Frames the whole topology on first paint and whenever `fitSignal` changes. */
function FitView({ bounds, fitSignal }) {
  const { camera, controls, size } = useThree();
  const lastSignal = useRef(fitSignal);
  const hasFitted = useRef(false);

  useFrame(() => {
    const requested = fitSignal !== lastSignal.current;
    // Wait for a real canvas size: at mount the layout has not settled yet, so
    // fitting on frame one would frame against the wrong viewport.
    const firstRun = !hasFitted.current && size.height > 0 && bounds.hasContent;
    if (!requested && !firstRun) return;

    lastSignal.current = fitSignal;
    if (!controls || !bounds.hasContent) return;
    hasFitted.current = true;

    const center = new THREE.Vector3()
      .addVectors(bounds.min, bounds.max)
      .multiplyScalar(0.5);
    const radius = Math.max(
      SCENE.fit.minDistance / 2,
      bounds.max.distanceTo(bounds.min) / 2
    );
    const fovRadians = THREE.MathUtils.degToRad(camera.fov);
    const distance = Math.max(
      SCENE.fit.minDistance,
      (radius * SCENE.fit.padding) / Math.sin(fovRadians / 2)
    );

    const direction = new THREE.Vector3()
      .subVectors(camera.position, controls.target)
      .normalize();
    if (direction.lengthSq() < 1e-6) direction.set(1, 1, 1).normalize();

    camera.position.copy(center).addScaledVector(direction, distance);
    controls.target.copy(center);
    controls.update();
  });

  return null;
}

/* ------------------------------------------------------------------ *
 * Root
 * ------------------------------------------------------------------ */

function Network3D({
  routers,
  links,
  selectedRouter,
  onRouterClick,
  routingTable,
  routingColumns,
  routingRowLabel,
  routingCorrectness,
  decorations,
  routeTreeEdges,
  packets,
  highlightedPath,
  downRouters,
  infinityCost,
  fitSignal,
}) {
  const bounds = useMemo(() => {
    const entries = Object.values(routers);
    if (entries.length === 0) {
      return {
        hasContent: false,
        min: new THREE.Vector3(-5, 0, -5),
        max: new THREE.Vector3(5, 0, 5),
      };
    }
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    entries.forEach((router) => {
      min.min(new THREE.Vector3(router.x, router.y, router.z));
      max.max(new THREE.Vector3(router.x, router.y, router.z));
    });
    return { hasContent: true, min, max };
  }, [routers]);

  // Which links lie on the highlighted path, as an order-independent lookup.
  const pathEdges = useMemo(() => {
    const edges = new Set();
    for (let i = 0; i + 1 < (highlightedPath?.length || 0); i += 1) {
      edges.add(edgeKey(highlightedPath[i], highlightedPath[i + 1]));
    }
    return edges;
  }, [highlightedPath]);

  /**
   * Link decorations, with the route-tree overlay folded in underneath.
   *
   * The overlay is a view toggle and the protocol's own decorations are the
   * truth, so a link the protocol calls `blocked` stays blocked even when the
   * selected router's table happens to route through it.
   */
  const linkDecorations = useMemo(() => {
    const merged = {};
    (routeTreeEdges || new Set()).forEach((key) => {
      merged[key] = 'tree';
    });
    return { ...merged, ...(decorations?.links || {}) };
  }, [decorations, routeTreeEdges]);

  const routerDecorations = decorations?.routers || {};
  const isDown = (id) => downRouters?.has(id);

  return (
    <>
      <ambientLight intensity={SCENE.lights.ambientIntensity} />
      <directionalLight
        position={SCENE.lights.keyPosition}
        intensity={SCENE.lights.keyIntensity}
      />
      <directionalLight
        position={SCENE.lights.fillPosition}
        intensity={SCENE.lights.fillIntensity}
      />

      <AdaptiveGrid bounds={bounds} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
      <FitView bounds={bounds} fitSignal={fitSignal} />

      {Object.entries(routers).map(([id, router]) => (
        <Router
          key={id}
          id={id}
          position={[router.x, router.y, router.z]}
          isSelected={id === selectedRouter}
          isDown={isDown(id)}
          decoration={routerDecorations[id]}
          onSelect={onRouterClick}
          table={id === selectedRouter ? routingTable : null}
          columns={routingColumns}
          rowLabel={routingRowLabel}
          correctness={id === selectedRouter ? routingCorrectness : null}
          infinityCost={infinityCost}
          peers={routers}
        />
      ))}

      {links.map((link) => {
        const source = routers[link.source];
        const target = routers[link.destination];
        if (!source || !target) return null;
        return (
          <Link
            key={`${link.source} ${link.destination}`}
            sx={source.x}
            sy={source.y}
            sz={source.z}
            tx={target.x}
            ty={target.y}
            tz={target.z}
            cost={link.cost}
            decoration={linkDecorations[edgeKey(link.source, link.destination)]}
            isHighlighted={pathEdges.has(edgeKey(link.source, link.destination))}
            isDimmed={isDown(link.source) || isDown(link.destination)}
          />
        );
      })}

      {packets.map((packet) => {
        const source = routers[packet.from];
        const target = routers[packet.to];
        if (!source || !target) return null;
        return (
          <Packet
            key={packet.key}
            sx={source.x}
            sy={source.y}
            sz={source.z}
            tx={target.x}
            ty={target.y}
            tz={target.z}
            kind={packet.kind}
            label={packet.label}
            startedAt={packet.startedAt}
            duration={packet.duration}
          />
        );
      })}

      {highlightedPath?.length > 1 && (
        <PathPulse path={highlightedPath} routers={routers} />
      )}
    </>
  );
}

export default Network3D;
