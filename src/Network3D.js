import React, { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
<<<<<<< HEAD
<<<<<<< HEAD
import { Text, OrbitControls, Html } from '@react-three/drei';
=======
import { Text, OrbitControls } from '@react-three/drei';
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
import { Text, OrbitControls } from '@react-three/drei';
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
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

function Link({ source, target, cost }) {
    const startPoint = new THREE.Vector3(source[0], source[1], source[2]);
    const endPoint = new THREE.Vector3(target[0], target[1], target[2]);

    const points = [startPoint, endPoint];
    const curve = new THREE.LineCurve3(startPoint, endPoint);
    const geometry = new THREE.TubeGeometry(curve, 20, 0.05, 8, false);

    return (
        <mesh geometry={geometry}>
            <meshStandardMaterial color="#90CAF9" />
            <Text
                position={[
                    (source[0] + target[0]) / 2,
                    (source[1] + target[1]) / 2 + 0.5,
                    (source[2] + target[2]) / 2
                ]}
                fontSize={0.3}
                color="#333333"
                anchorX="center"
                anchorY="middle"
            >
                {cost}
            </Text>
        </mesh>
    );
}

function Animation({ source, target, progress }) {
    const startPoint = new THREE.Vector3(source[0], source[1], source[2]);
    const endPoint = new THREE.Vector3(target[0], target[1], target[2]);

    const points = [startPoint, endPoint];
    const curve = new THREE.LineCurve3(startPoint, endPoint);
    const position = curve.getPoint(progress);

    return (
        <mesh position={position}>
            <circleGeometry args={[0.2, 16]} />
            <meshStandardMaterial color="#FF5722" />
        </mesh>
    );
}

function Grid() {
    return (
        <gridHelper args={[40, 40, '#F5F5F5', '#EEEEEE']} />
    );
}

function Network3D({
    routers,
    links,
    selectedRouter,
    onRouterClick,
    routingTable,
<<<<<<< HEAD
<<<<<<< HEAD
    animations,
    iteration
=======
    animations
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
    animations
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
}) {
    return (
        <>
            <ambientLight intensity={0.5} />
            <pointLight position={[10, 10, 10]} />
            <OrbitControls />
            <Grid />

            {Object.entries(routers).map(([id, router]) => (
                <Router
                    key={id}
                    position={[router.x, router.y, router.z]}
                    id={id}
                    isSelected={selectedRouter === id}
                    onClick={() => onRouterClick(id)}
                    routingTable={selectedRouter === id ? routingTable : null}
                    allRouters={routers}
                />
            ))}

            {links.map((link, index) => {
                const source = routers[link.source];
                const target = routers[link.destination];
                if (!source || !target) return null;

                return (
                    <Link
                        key={index}
                        source={[source.x, source.y, source.z]}
                        target={[target.x, target.y, target.z]}
                        cost={link.cost}
                    />
                );
            })}

            {animations.map((anim, index) => {
                const source = routers[anim.source];
                const target = routers[anim.target];
                if (!source || !target) return null;

                return (
                    <Animation
                        key={index}
                        source={[source.x, source.y, source.z]}
                        target={[target.x, target.y, target.z]}
                        progress={anim.progress}
                    />
                );
            })}
<<<<<<< HEAD
<<<<<<< HEAD

            {/* Add iteration overlay */}
            <Html position={[0, 10, 0]}>
                <div className="iteration-overlay">
                    <div className="iteration-info">
                        <h3>Iteration {iteration}</h3>
                        {animations.some(anim => anim.iteration === iteration) && (
                            <div className="active-iteration">
                                <div className="pulse-dot"></div>
                                <span>Updating...</span>
                            </div>
                        )}
                    </div>
                </div>
            </Html>
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
        </>
    );
}

export default Network3D; 