export class Darkness5e {
    static onRenderTokenConfig(config, html, data) {
        const visionTab = $('div.tab[data-tab="vision"] div.form-group:nth-child(4)');
        renderTemplate("modules/darkness_5e/templates/extra_vision_ranges.html", data.object || {})
            .then(extraSenses => visionTab.after(extraSenses));
    }
    static onRenderMeasuredTemplateConfig(config, html, data) {
        const visionTab = $('div.form-group:first');
        renderTemplate("modules/darkness_5e/templates/extra_measure.html", data.object || {})
            .then(extraCode => visionTab.after(extraCode));
    }

    static getDarkZones() {
        let dzs = [];
        for (let dz of canvas.templates.placeables) {
            if (dz.getFlag("darkness_5e", "darkness")) {
                dzs.push(dz);
            }
        }
        return dzs;
    }

    static getDarkZonesEndpoints(zone) {
        if (zone.shape instanceof NormalizedRectangle) {
            let x = zone.data.x + zone.shape.x;
            let y = zone.data.y + zone.shape.y;
            return [
                [x, y],
                [x + zone.shape.width, y],
                [x + zone.shape.width, y + zone.shape.height],
                [x, y + zone.shape.height]
            ];
        }
        else if (zone.shape instanceof PIXI.Circle) {
            let points = [];
            let r = zone.data.distance * (canvas.dimensions.size / canvas.dimensions.distance);
            for (let i = 0; i < 16; ++i) {
                points.push([zone.data.x + Math.cos(Math.PI * i / 8) * r, zone.data.y + Math.sin(Math.PI * i / 8) * r]);
            }
            return points
        }
        return [];
    }

    static isInDarknessZone(p, zone) {
        if (zone.shape instanceof NormalizedRectangle) {
            let x = zone.data.x + zone.shape.x;
            let y = zone.data.y + zone.shape.y;
            return p.x > x && p.y > y && p.x < x + zone.shape.width && p.y < y + zone.shape.height;
        }
        else if (zone.shape instanceof PIXI.Circle) {
            let dx = p.x - zone.x;
            let dy = p.y - zone.y;
            let r = zone.data.distance * (canvas.dimensions.size / canvas.dimensions.distance);
            return dx * dx + dy * dy < r * r;
        }
        return false;
    }

    static computeSight(origin, radius, {devilSight=0, angle=360, density=6, rotation=0, unrestricted=false}={}) {
        // Get the maximum sight distance and the limiting radius
        let d = canvas.dimensions;
        let {x, y} = origin;

        let distance = Math.max(radius,
            Math.hypot(
                Math.max(origin.x - d.sceneRect.x, d.sceneRect.width - origin.x + d.sceneRect.x),
                Math.max(origin.y - d.sceneRect.y, d.sceneRect.height - origin.y + d.sceneRect.y)
            )
        );

        // Determine the direction of facing, the angle of vision, and the angles of boundary rays
        const limitAngle = angle.between(0, 360, false);
        const aMin = limitAngle ? normalizeRadians(toRadians(rotation + 90 - (angle / 2))) : -Math.PI;
        const aMax = limitAngle ? aMin + toRadians(angle) : Math.PI;
        devilSight = devilSight || 0;

        let darkZones = devilSight > 0 ? [] : Darkness5e.getDarkZones();

        var isInAnyDarknessZone = false;
        for (let dz of darkZones) {
            if (Darkness5e.isInDarknessZone(origin, dz)) {
                isInAnyDarknessZone = true;
                break;
            }
        }

        // minimum visible distance
        let minD = 1.5 * (canvas.dimensions.size / canvas.dimensions.distance);

        // For high wall count maps, restrict to a subset of endpoints using quadtree bounds
        // Target wall endpoints within the vision radius or within 10 grid units, whichever is larger
        let endpoints = [];
        let bounds = null;
        if (!isInAnyDarknessZone || devilSight > 0) {
            if (!unrestricted) {
                endpoints = canvas.walls.endpoints || [];
            }
            if ( endpoints.length > SightLayer.EXACT_VISION_THRESHOLD ) {
                const rb2 = Math.max(d.size * 10, radius);
                bounds = new NormalizedRectangle(origin.x - rb2, origin.y - rb2, (2 * rb2), (2 * rb2));
                let walls = canvas.walls.quadtree.getObjects(bounds);
                endpoints = WallsLayer.getUniqueEndpoints(walls, {bounds, blockMovement: false, blockSenses: true});
            }
            if (!unrestricted) {
                for (let dz of darkZones) {
                    endpoints.push(...Darkness5e.getDarkZonesEndpoints(dz));
                }
            }
        } else {
            distance = minD;
            density = 20;
        }

        // Cast sight rays at target endpoints using the full unrestricted line-of-sight distance
        const rays = SightLayer._castRays(x, y, distance, {density, endpoints, limitAngle, aMin, aMax});

        // Partition rays by node
        const quadMap = new Map();
        for ( let r of rays ) {
            r._cs = null;
            r._c = null;
            const nodes = canvas.walls.quadtree.getLeafNodes(r.bounds);
            for ( let n of nodes ) {
                let s = quadMap.get(n);
                if ( !s ) {
                    s = new Set();
                    quadMap.set(n, s);
                }
                s.add(r);
            }
        }

        if ( unrestricted ) nodeQueue.clear();

        Darkness5e.computeCollideWithWalls(rays, origin, quadMap);
        Darkness5e.computeCollideWithDarkness(rays, darkZones, devilSight, minD);

        return Darkness5e.packRaysToLosAndFox(rays, radius, bounds, endpoints);
    }

    static packRaysToLosAndFox(rays, radius, bounds, endpoints) {
        // Construct visibility polygons
        const losPoints = [];
        const fovPoints = [];
        for ( let r of rays ) {
            r.los = r.B;
            losPoints.push(r.los);
            if (r.distance > radius) {
                r.fov = r.project(radius / r.distance);
            } else {
                r.fov = r.B;
            }
            fovPoints.push(r.fov);
        }
        const los = new PIXI.Polygon(...losPoints);
        const fov = new PIXI.Polygon(...fovPoints);

        // Visualize vision rendering
        if ( CONFIG.debug.sightRays ) Darkness5e._visualizeSight(bounds, endpoints, rays, los, fov);
        if ( CONFIG.debug.sight ) SightLayer._performance.rays = rays.length;

        // Return rays and polygons
        return {rays, los, fov};
    }

    static moveRayEnd(r, B) {
        r.B = {x:B.x, y:B.y};
        r.dx = r.B.x - r.A.x;
        r.dy = r.B.y - r.A.y;
        r.distance = Math.hypot(r.dx, r.dy);
    }

    static computeCollideWithDarkness(rays, darknessZones, dsRadius, minD) {
        let canvasDim = canvas.dimensions;
        for (let r of rays) {
            for (let zone of darknessZones) {
                let ray = r;
                let x = zone.data.x;
                let y = zone.data.y;
                if (zone.shape instanceof NormalizedRectangle) {
                    Darkness5e.collideRayAgainstBox(ray, {x:x, y:y, width:zone.shape.width, height:zone.shape.height}, minD);
                }
                else if (zone.shape instanceof PIXI.Circle) {
                    Darkness5e.collideRayAgainstCircle(ray, {x:x, y:y, radius:zone.data.distance * (canvas.dimensions.size / canvas.dimensions.distance)}, minD);
                }
                if (ray.distance > dsRadius && Darkness5e.isInDarknessZone(ray.project(dsRadius / ray.distance), zone)) {
                    Darkness5e.moveRayEnd(ray, ray.project(Math.max(dsRadius, minD) / ray.distance));
                }
            }
        }
    }

    static collideRayAgainstBox(ray, box, minD) {
        if (box.width <= 0 || box.height <= 0) return;
        let maskA = Darkness5e.boxMask(ray.A, box);
        if (maskA == 0) {
            Darkness5e.moveRayEnd(ray, ray.project(minD / ray.distance));
            return;
        }
        let maskB = Darkness5e.boxMask(ray.B, box);
        if (maskA & maskB) {
            return;
        }
        let rx = ray.A.x;
        let ry = ray.A.y;
        do {
            let maskAx = maskA&3;
            let maskBx = maskB&3;
            if (maskAx != 0 && maskAx != maskBx) {
                if (maskAx == 1 || (maskAx == 0 && maskBx == 1)) {
                    var dx = box.x - rx;
                    rx = box.x;
                    ry = ry + ray.dy * dx / ray.dx;
                }
                else if (maskAx == 2 || (maskAx == 0 && maskBx == 2)) {
                    var dx = box.x + box.width - rx;
                    rx = box.x + box.width;
                    ry = ry + ray.dy * dx / ray.dx;
                }
                maskA = ((ry < box.y) ? 4 : 0) |
                        ((ry > box.y + box.height) ? 8 : 0);
                if (maskA == 0) {
                    break;
                }
            }
            let maskAy = maskA&12;
            let maskBy = maskB&12;
            if (maskAy != maskBy) {
                if (maskAy == 4 || (maskAy == 0 && maskBy == 4)) {
                    var dy = box.y - ry;
                    rx = rx + ray.dx * dy / ray.dy;
                    ry = box.y;
                }
                else if (maskAy == 8 || (maskAy == 0 && maskBy == 8)) {
                    var dy = box.y + box.height - ry;
                    rx = rx + ray.dx * dy / ray.dy;
                    ry = box.y + box.height;
                }
                maskA = ((rx < box.x) ? 1 : 0) |
                        ((rx > box.x + box.width) ? 2 : 0);
            }
        } while(false);
        if (maskA == 0) {
            Darkness5e.moveRayEnd(ray, { x:rx, y:ry });
        }
    }

    static collideRayAgainstCircle(ray, circle, minD) {
        if (circle.radius <= 0) return;
        let r2 = circle.radius * circle.radius;
        let ac = { x: circle.x - ray.A.x, y: circle.y - ray.A.y };
        ac.sqlen = ac.x * ac.x + ac.y * ac.y;
        if (ac.sqlen < r2) {
            Darkness5e.moveRayEnd(ray, ray.project(minD / ray.distance));
        } else {
            let an = (ray.dx * ac.x + ray.dy * ac.y) / Math.sqrt(ray.dx * ray.dx + ray.dy * ray.dy);
            if (an > 0) {
                let d = r2 - ac.sqlen + an * an;
                if (d > 0) {
                    let l = an - Math.sqrt(d);
                    if (l < ray.distance) {
                        Darkness5e.moveRayEnd(ray, ray.project(l / ray.distance));
                    }
                }
            }
        }
    }

    static boxMask(point, box) {
        return ((point.x < box.x) ? 1 : 0) |
            ((point.x > box.x + box.width) ? 2 : 0) |
            ((point.y < box.y) ? 4 : 0) |
            ((point.y > box.y + box.height) ? 8 : 0);
    }

    static computeCollideWithWalls(rays, origin, quadMap) {
        const rayQueue = new Set(rays);

        // Start with the node that contains the sight origin
        let nodes = new Set(canvas.walls.quadtree.getLeafNodes({x: origin.x, y: origin.y, width: 0, height: 0}));
        const testedNodes = new Set();
        const nodeQueue = new Set(nodes);

        // Iterate until there are no nodes remaining to test
        while ( nodeQueue.size ) {
            const batch = Array.from(nodeQueue);
            for (let n of batch) {
                for (let o of n.objects) {
                    const w = o.t;
                    if ((w.data.door > CONST.WALL_DOOR_TYPES.NONE) && (w.data.ds === CONST.WALL_DOOR_STATES.OPEN)) continue;
                    if (w.data.sense === CONST.WALL_SENSE_TYPES.NONE) continue;

                    // Iterate over rays
                    const rays = quadMap.get(n) || [];
                    for (let r of rays) {
                        if ( r._c ) continue;

                        // Test collision for the ray
                        if (!w.canRayIntersect(r)) continue;
                        const x = WallsLayer.testWall(r, w);
                        if ( this._performance ) this._performance.tests++;
                        if (!x) continue;

                      // Flag the collision
                        r._cs = r._cs || {};
                        const pt = `${Math.round(x.x)},${Math.round(x.y)}`;
                        const c = r._cs[pt];
                        if ( c ) {
                            c.sense = Math.min(w.data.sense, c.sense);
                            for ( let n of o.n ) c.nodes.push(n);
                        }
                        else {
                            x.sense = w.data.sense;
                            x.nodes = Array.from(o.n);
                            r._cs[pt] = x;
                        }
                    }
                }

                // Cascade outward to sibling nodes
                testedNodes.add(n);
                nodeQueue.delete(n);
                const siblings = canvas.walls.quadtree.getLeafNodes({
                    x: n.bounds.x - 1,
                    y: n.bounds.y - 1,
                    width: n.bounds.width + 2,
                    height: n.bounds.height + 2
                });
                for (let s of siblings) {
                    if (!testedNodes.has(s)) nodeQueue.add(s);
                }
            }

            // After completing a tier of nodes, test each ray for completion
            for ( let r of rayQueue ) {
                if ( !r._cs ) continue;
                const c = Object.values(r._cs);
                const closest = WallsLayer.getClosestCollision(c);
                if ( closest && closest.nodes.every(n => testedNodes.has(n)) ) {
                    rayQueue.delete(r);
                    r._c = closest;
                }
            }
            if ( !rayQueue.size ) break;
        }

        for ( let r of rays ) {
            if (r._c) {
                Darkness5e.moveRayEnd(r, r._c);
            }
        }
    }

    static _visualizeSight(bounds, endpoints, rays, los, fov) {
      const debug = canvas.controls.debug;
      if (!debug) return;
      debug.clear();

      // Relevant polygons
      if ( bounds ) debug.lineStyle(0).beginFill(0x66FFFF, 0.1).drawShape(bounds);
      debug.beginFill(0x66FFFF, 0.1).drawShape(los);
      debug.beginFill(0xFF66FF, 0.1).drawShape(fov).endFill();

      // Tested endpoints
      debug.beginFill(0x00FFFF, 1.0);
      endpoints.forEach(pt => debug.drawCircle(pt[0], pt[1], 6));
      debug.endFill();

      // Cast rays
      for ( let r of rays ) {
        debug.lineStyle(1, 0x00FF00).moveTo(r.A.x, r.A.y).lineTo(r.fov.x, r.fov.y)
          .lineStyle(2, 0x00FF00).drawCircle(r.fov.x, r.fov.y, 4)
          .lineStyle(1, 0xFF0000).lineTo(r.los.x, r.los.y)
          .lineStyle(2, 0xFF0000).drawCircle(r.los.x, r.los.y, 4);
      }
    }
}

class TokenVision {
    constructor() {
        this.ignored = false;
        this.dragging = false;
    }

    get value() {
        return !(this.ignore || this.dragging);
    }

    update() {
        let newValue = this.value;
        if (canvas) {
            canvas.lighting.visible = newValue;
            canvas.sight.visible = newValue;
        }
    }
}

Hooks.on("renderTokenConfig", (tokenConfig, html, data) => {
    Darkness5e.onRenderTokenConfig(tokenConfig, html, data);
});
Hooks.on("renderMeasuredTemplateConfig", (zoneConfig, html, data) => {
    Darkness5e.onRenderMeasuredTemplateConfig(zoneConfig, html, data);
});
Hooks.on("canvasInit", () => {
    canvas.token_vision = new TokenVision();
});
Hooks.on("canvasReady", () => {
    if (canvas.token_vision) {
        canvas.token_vision.update();
        let defTokenVision = Object.getOwnPropertyDescriptor(SightLayer.prototype, "tokenVision")
        Object.defineProperty(SightLayer.prototype, "tokenVision", {
            get: function() {
                return canvas.token_vision.value && defTokenVision.get.call(this);
            }
        });
    }
});
