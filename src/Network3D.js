import React, { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';

function Router({ position, id, isSelected, onClick, routingTable, allRouters }) {
    const meshRef = useRef();
    const [hovered, setHovered] = useState(false);

    // Function to determine the best position for the routing table
    const getTablePosition = () => {
        if (!allRouters || Object.keys(allRouters).length === 0) {
            return [3.5, 0, 0]; // Default position if no router data
        }

        // Possible positions to check (right, left, top, bottom, front, back)
        const possiblePositions = [
            [4, 0, 0],    // right
            [-4, 0, 0],   // left
            [0, 4, 0],    // top
            [0, -4, 0],   // bottom
            [0, 0, 4],    // front
            [0, 0, -4]    // back
        ];

        // Current router position as Vector3
        const routerPos = new THREE.Vector3(position[0], position[1], position[2]);

        // Find the best position with maximum distance to other routers
        let bestPosition = possiblePositions[0];
        let maxMinDistance = 0;

        possiblePositions.forEach(pos => {
            const tablePos = new THREE.Vector3(
                routerPos.x + pos[0],
                routerPos.y + pos[1],
                routerPos.z + pos[2]
            );

            // Calculate minimum distance to all other routers
            let minDistance = Infinity;
            Object.entries(allRouters).forEach(([routerId, router]) => {
                if (routerId !== id) { // Skip the current router
                    const otherPos = new THREE.Vector3(router.x, router.y, router.z);
                    const distance = tablePos.distanceTo(otherPos);
                    minDistance = Math.min(minDistance, distance);
                }
            });

            // Update best position if this one has a larger minimum distance
            if (minDistance > maxMinDistance) {
                maxMinDistance = minDistance;
                bestPosition = pos;
            }
        });

        return bestPosition;
    };

    // Get the best position for the table
    const tablePosition = getTablePosition();

    return (
        <group position={position}>
            <mesh
                ref={meshRef}
                onClick={onClick}
                onPointerOver={() => setHovered(true)}
                onPointerOut={() => setHovered(false)}
            >
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial
                    color={hovered ? '#1976D2' : '#B3E5FC'}
                    metalness={0.1}
                    roughness={0.6}
                    transparent={true}
                    opacity={0.8}
                />
            </mesh>

            {/* Front */}
            <Text
                position={[0, 0, 0.51]}
                fontSize={0.4}
                color="#000000"
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.02}
                outlineColor="#ffffff"
            >
                {id}
            </Text>

            {/* Back */}
            <Text
                position={[0, 0, -0.51]}
                fontSize={0.4}
                color="#000000"
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.02}
                outlineColor="#ffffff"
                rotation={[0, Math.PI, 0]}
            >
                {id}
            </Text>

            {/* Left */}
            <Text
                position={[-0.51, 0, 0]}
                fontSize={0.4}
                color="#000000"
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.02}
                outlineColor="#ffffff"
                rotation={[0, -Math.PI / 2, 0]}
            >
                {id}
            </Text>

            {/* Right */}
            <Text
                position={[0.51, 0, 0]}
                fontSize={0.4}
                color="#000000"
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.02}
                outlineColor="#ffffff"
                rotation={[0, Math.PI / 2, 0]}
            >
                {id}
            </Text>

            {/* Top */}
            <Text
                position={[0, 0.51, 0]}
                fontSize={0.4}
                color="#000000"
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.02}
                outlineColor="#ffffff"
                rotation={[-Math.PI / 2, 0, 0]}
            >
                {id}
            </Text>

            {/* Bottom */}
            <Text
                position={[0, -0.51, 0]}
                fontSize={0.4}
                color="#000000"
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.02}
                outlineColor="#ffffff"
                rotation={[Math.PI / 2, 0, 0]}
            >
                {id}
            </Text>

            {isSelected && routingTable && (
                <group position={tablePosition}>
                    <mesh>
                        <planeGeometry args={[5, 4]} />
                        <meshStandardMaterial color="#1976D2" />
                    </mesh>

                    {/* Title */}
                    <Text
                        position={[0, 1.7, 0.1]}
                        fontSize={0.3}
                        color="#ffffff"
                        anchorX="center"
                        anchorY="top"
                        fontWeight="bold"
                    >
                        Router {id} Routing Table
                    </Text>

                    {/* Column Headers */}
                    <Text
                        position={[-1.8, 1.2, 0.1]}
                        fontSize={0.25}
                        color="#ffffff"
                        anchorX="center"
                        anchorY="top"
                    >
                        Router
                    </Text>
                    <Text
                        position={[-0.6, 1.2, 0.1]}
                        fontSize={0.25}
                        color="#ffffff"
                        anchorX="center"
                        anchorY="top"
                    >
                        Distance
                    </Text>
                    <Text
                        position={[0.6, 1.2, 0.1]}
                        fontSize={0.25}
                        color="#ffffff"
                        anchorX="center"
                        anchorY="top"
                    >
                        Next Hop
                    </Text>

                    {/* Data Rows */}
                    {Object.entries(routingTable).map(([dest, info], index) => (
                        <group key={dest}>
                            <Text
                                position={[-1.8, 0.8 - index * 0.3, 0.1]}
                                fontSize={0.22}
                                color="#ffffff"
                                anchorX="center"
                                anchorY="top"
                            >
                                {dest}
                            </Text>
                            <Text
                                position={[-0.6, 0.8 - index * 0.3, 0.1]}
                                fontSize={0.22}
                                color="#ffffff"
                                anchorX="center"
                                anchorY="top"
                            >
                                {info.cost === Infinity ? "∞" : info.cost}
                            </Text>
                            <Text
                                position={[0.6, 0.8 - index * 0.3, 0.1]}
                                fontSize={0.22}
                                color="#ffffff"
                                anchorX="center"
                                anchorY="top"
                            >
                                {info.nextHop}
                            </Text>
                        </group>
                    ))}
                </group>
            )}
        </group>
    );
}

function Link({ source, target, cost, isPathHighlighted }) {
    // Create a curve for the link
    const points = [];
    const numPoints = 20;
    const linkRef = useRef();
    const [hovered, setHovered] = useState(false);

    // Calculate the start and end points
    const startX = source[0];
    const startY = source[1];
    const startZ = source[2];
    const endX = target[0];
    const endY = target[1];
    const endZ = target[2];

    // Create points along the line
    for (let i = 0; i < numPoints; i++) {
        const t = i / (numPoints - 1);
        const x = startX + t * (endX - startX);
        const y = startY + t * (endY - startY);
        const z = startZ + t * (endZ - startZ);
        points.push(new THREE.Vector3(x, y, z));
    }

    const curve = new THREE.CatmullRomCurve3(points);
    const tubeGeometry = new THREE.TubeGeometry(curve, 64, 0.05, 8, false);

    // Use useFrame to create a subtle animation effect on the link
    useFrame(({ clock }) => {
        if (linkRef.current) {
            if (isPathHighlighted) {
                // Strong glowing effect for highlighted path
                const glowPulse = Math.sin(clock.getElapsedTime() * 4) * 0.2 + 0.8;
                linkRef.current.material.opacity = 0.9;
                linkRef.current.material.emissiveIntensity = glowPulse * 0.8;
            } else {
                // Subtle pulsating effect for regular links
                const pulse = Math.sin(clock.getElapsedTime() * 2) * 0.1 + 0.9;
                linkRef.current.material.opacity = hovered ? 0.9 : (0.6 + Math.sin(clock.getElapsedTime()) * 0.1);
                linkRef.current.material.emissiveIntensity = hovered ? 0.3 : 0.1;
            }
        }
    });

    // Determine link color based on highlighted status
    const linkColor = isPathHighlighted ? "#FF3D00" : (hovered ? "#1565C0" : "#2E7D32");
    const emissiveColor = isPathHighlighted ? "#FF3D00" : (hovered ? "#1565C0" : "#2E7D32");

    return (
        <group>
            <mesh
                ref={linkRef}
                onPointerOver={() => setHovered(true)}
                onPointerOut={() => setHovered(false)}
            >
                <primitive object={tubeGeometry} />
                <meshStandardMaterial
                    color={linkColor}
                    transparent={true}
                    opacity={isPathHighlighted ? 0.9 : 0.8}
                    emissive={emissiveColor}
                    emissiveIntensity={isPathHighlighted ? 0.6 : (hovered ? 0.3 : 0.1)}
                />
            </mesh>
            <Text
                position={[(startX + endX) / 2, (startY + endY) / 2 + 0.3, (startZ + endZ) / 2]}
                fontSize={0.3}
                color={isPathHighlighted ? "#FF0000" : "#000000"}
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.03}
                outlineColor="#ffffff"
                fillOpacity={0.8}
            >
                {cost}
            </Text>
        </group>
    );
}

function Animation({ source, target, progress, type }) {
    const animMeshRef = useRef();

    // Use the animation progress to move the animation along the link
    const positionX = source[0] + (target[0] - source[0]) * progress;
    const positionY = source[1] + (target[1] - source[1]) * progress;
    const positionZ = source[2] + (target[2] - source[2]) * progress;

    // Set color based on type (update, failure, etc.)
    let color;
    let textColor;

    if (type === 'failure') {
        color = '#00008B'; // Lighter red for failure
        textColor = '#000000'; // Darker red text for better contrast
    } else {
        color = '00008B'; // Lighter blue for regular updates
        textColor = '#000000'; // Darker blue text for better contrast
    }

    // Calculate pulse scale based on progress for a stronger pulsating effect
    const pulseScale = 1 + Math.sin(progress * Math.PI * 4) * 0.3;

    return (
        <group>
            <mesh
                ref={animMeshRef}
                position={[positionX, positionY, positionZ]}
                scale={[pulseScale * 0.3, pulseScale * 0.3, pulseScale * 0.3]}
            >
                <sphereGeometry args={[1, 16, 16]} />
                <meshStandardMaterial
                    color={'#00008B'}
                    emissive={'#00008B'}
                    emissiveIntensity={0.5}
                    transparent={true}
                    opacity={0.5}
                />
            </mesh>

            {/* Add DV text to the animation ball */}
            <Text
                position={[positionX, positionY, positionZ]}
                fontSize={0.3}
                color={textColor}
                anchorX="center"
                anchorY="middle"
                fontWeight="bold"
                outlineWidth={0.02}
                outlineColor="#FFFFFF"
            >
                DV
            </Text>
        </group>
    );
}

function Grid() {
    return (
        <gridHelper args={[50, 50, 0x888888, 0x444444]} />
    );
}

function Network3D({
    routers,
    links,
    selectedRouter,
    onRouterClick,
    routingTable,
    animations,
    iteration,
    highlightedPath
}) {
    // References to objects
    const controlsRef = useRef();

    // Animation state
    useFrame(() => {
        if (controlsRef.current) {
            controlsRef.current.update();
        }
    });

    // Create router objects
    const routerObjects = Object.entries(routers).map(([id, router]) => (
        <Router
            key={id}
            position={[router.x, router.y, router.z]}
            id={id}
            isSelected={id === selectedRouter}
            onClick={(e) => {
                e.stopPropagation();
                onRouterClick(id);
            }}
            routingTable={id === selectedRouter ? routingTable : null}
            allRouters={routers}
        />
    ));

    // Create link objects
    const linkObjects = links.map((link, index) => {
        const sourceRouter = routers[link.source];
        const targetRouter = routers[link.destination];

        if (!sourceRouter || !targetRouter) return null;

        // Check if this link is part of the highlighted path
        let isInPath = false;
        if (highlightedPath && highlightedPath.length > 1) {
            // Check each consecutive pair of routers in the path
            for (let i = 0; i < highlightedPath.length - 1; i++) {
                const pathSource = highlightedPath[i];
                const pathTarget = highlightedPath[i + 1];

                // Check if this link connects the current path segment (in either direction)
                if ((link.source === pathSource && link.destination === pathTarget) ||
                    (link.source === pathTarget && link.destination === pathSource)) {
                    isInPath = true;
                    break;
                }
            }
        }

        return (
            <Link
                key={`${link.source}-${link.destination}`}
                source={[sourceRouter.x, sourceRouter.y, sourceRouter.z]}
                target={[targetRouter.x, targetRouter.y, targetRouter.z]}
                cost={link.cost}
                isPathHighlighted={isInPath}
            />
        );
    });

    // Create animation objects
    const animationObjects = animations.map((anim, index) => {
        const sourceRouter = routers[anim.source];
        const targetRouter = routers[anim.target];

        if (!sourceRouter || !targetRouter) return null;

        return (
            <Animation
                key={`${anim.source}-${anim.target}-${index}`}
                source={[sourceRouter.x, sourceRouter.y, sourceRouter.z]}
                target={[targetRouter.x, targetRouter.y, targetRouter.z]}
                progress={anim.progress}
                type={anim.type}
            />
        );
    });

    // Path animation (only shown when a path is highlighted)
    const pathAnimation = highlightedPath && highlightedPath.length > 1 ? (
        <PathAnimation path={highlightedPath} routers={routers} />
    ) : null;

    return (
        <>
            <ambientLight intensity={0.5} />
            <pointLight position={[10, 10, 10]} intensity={0.8} />
            <Grid />
            <OrbitControls ref={controlsRef} />
            {routerObjects}
            {linkObjects}
            {animationObjects}
            {pathAnimation}

            {/* Add iteration overlay */}
            <Html position={[0, 10, 0]}>
                <div className="iteration-overlay">
                    <span>Iteration: {iteration}</span>
                </div>
            </Html>
        </>
    );
}

// Add this new component for path animation
function PathAnimation({ path, routers }) {
    const [progress, setProgress] = useState(0);
    const animMeshRef = useRef();

    // Get positions of all routers in the path
    const positions = path.map(routerId => {
        const router = routers[routerId];
        return [router.x, router.y, router.z];
    });

    // Use useFrame to animate the progress
    useFrame(({ clock }) => {
        // Loop animation every 3 seconds
        const loopTime = 3;
        const time = clock.getElapsedTime() % loopTime;
        setProgress(time / loopTime);
    });

    // If less than 2 positions, don't render anything
    if (positions.length < 2) return null;

    // Calculate the total path length
    const totalLength = positions.reduce((total, pos, i) => {
        if (i === 0) return 0;
        const prev = positions[i - 1];
        const dx = pos[0] - prev[0];
        const dy = pos[1] - prev[1];
        const dz = pos[2] - prev[2];
        return total + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }, 0);

    // Calculate current position along the path
    const getCurrentPosition = () => {
        // If there's only one position, return it
        if (positions.length === 1) return positions[0];

        const targetDistance = progress * totalLength;
        let currentDistance = 0;

        // Find the current segment
        for (let i = 1; i < positions.length; i++) {
            const prev = positions[i - 1];
            const curr = positions[i];

            const dx = curr[0] - prev[0];
            const dy = curr[1] - prev[1];
            const dz = curr[2] - prev[2];

            const segmentLength = Math.sqrt(dx * dx + dy * dy + dz * dz);

            if (currentDistance + segmentLength >= targetDistance) {
                // We found our segment
                const segmentProgress = (targetDistance - currentDistance) / segmentLength;

                // Interpolate between points
                return [
                    prev[0] + dx * segmentProgress,
                    prev[1] + dy * segmentProgress,
                    prev[2] + dz * segmentProgress
                ];
            }

            currentDistance += segmentLength;
        }

        // If we're at the end, return the last position
        return positions[positions.length - 1];
    };

    const currentPos = getCurrentPosition();

    // Calculate pulse scale for a pulsating effect
    const pulseScale = 1 + Math.sin(progress * Math.PI * 6) * 0.2;

    return (
        <mesh
            ref={animMeshRef}
            position={currentPos}
            scale={[pulseScale * 0.2, pulseScale * 0.2, pulseScale * 0.2]}
        >
            <sphereGeometry args={[1, 16, 16]} />
            <meshStandardMaterial
                color="#00AAFF"
                emissive="#00AAFF"
                emissiveIntensity={1.5}
                transparent={true}
                opacity={0.9}
            />
        </mesh>
    );
}

export default Network3D; 