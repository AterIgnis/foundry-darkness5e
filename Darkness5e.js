import { Darkness5e } from "./module/Darkness5e.js";

function overrideMethod(source, name, convertor) {
  source[name] = convertor(source[name]);
}

class DSIlluminationShader extends AbstractBaseShader {
  static fragmentShader = `
  precision mediump float;
  uniform float alpha;
  uniform float ratio;
  uniform float ratioDS;
  uniform vec3 colorDim;
  uniform vec3 colorBright;
  uniform vec3 colorDS;
  varying vec2 vUvs;
  
  void main() {
      float dist = distance(vUvs, vec2(0.5)) * 2.0;
//      if (dist > ratioDS) discard;
      vec4 color = mix(vec4(colorDS, 0.00), vec4(mix(colorDim, colorBright, step(dist, ratio)) * alpha, 1.0), step(dist, ratioDS));
      gl_FragColor = color;
  }`;

  static defaultUniforms = {
    alpha: 1.0,
    ratio: 0.4,
    ratioDS: 0.8,
    colorDim: [0.5, 0.5, 0.5],
    colorBright: [1.0, 1.0, 1.0],
    colorDS: [1.0, 1.0, 1.0],
    time: 0,
    intensity: 5
  }
}

class ViewPointSource extends PointSource {
  constructor(...args) {
      super(...args);
      this.devil = 0;
      this.illumination.shader = DSIlluminationShader.create();
  }

  initialize({x, y, z, dim, bright, devil, angle, rotation, color, alpha, darknessThreshold, type, animation, seed}={}) {
    // Store data
    this.x = x;
    this.y = y;
    this.z = z ?? null;
    this.angle = angle ?? 360;
    this.rotation = rotation ?? 0;
    this.alpha = alpha ?? 0.5;
    this.color = color ? colorStringToHex(color) : null;
    this.colorRGB = hexToRGB(this.color);
    this.darknessThreshold = darknessThreshold ?? 0;
    this.animation = animation ? duplicate(animation) : {type: null};
    this.type = type ?? SOURCE_TYPES.LOCAL;

    // Record flags
    this.limited = (angle !== 360);

    // Define radii
    this.dim = Math.abs(dim) ?? 0;
    this.bright = Math.abs(bright) ?? 0;
    this.devil = Math.abs(devil) ?? 0;
    if (canvas.lighting.globalLight || canvas.lighting.darkness < 1) devil = 0;
    this.radius = Math.max(this.dim, this.bright, this.devil);
    this.ratio = Math.clamped(this.bright / this.radius, 0, 1);
    this.ratioDS = Math.clamped(this.dim / this.radius, 0, 1);

    // Compute polygons
    const {fov, los, rays} = SightLayer.computeSight({x: this.x, y: this.y}, this.radius, {
      devilSight: devil,
      angle: this.angle,
      rotation: this.rotation,
      unrestricted: this.type === SOURCE_TYPES.UNIVERSAL
    });
    this.fov = fov;
    if (dim < devil) {
      this.dimFov = this.limitView(rays, this.dim);
    } else {
      this.dimFov = this.fov;
    }
    this.los = los;

    this.illumination.light.blendMode = PIXI.BLEND_MODES.MAX_COLOR;
    this.illumination.zIndex = this.z ?? 0;
    this.coloration.light.blendMode = PIXI.BLEND_MODES.SCREEN;
    this.coloration.zIndex = this.z ?? 0;

    return this;
  }

  drawLight(channels) {
    channels = channels || canvas.lighting.channels;
    const c = this.illumination;
    const l = c.light;

    // Define common radius and dimensions
    l.position.set(this.x, this.y);
    l.width = l.height = this.radius * 2;
    c.uniforms.ratio = this.ratio;
    c.uniforms.ratioDS = this.ratioDS;

    // Draw darkness sources
    if ( this.darkness ) {
      c.uniforms.colorDim = channels.dark.rgb;
      c.uniforms.colorBright = channels.black.rgb;
    }
    // Draw light sources
    else {
      c.uniforms.colorDim = channels.dim.rgb;
      c.uniforms.colorBright = channels.bright.rgb;
      c.uniforms.colorDs = channels.bright.rgb;
    }

    // Draw the masking FOV polygon
    c.fov.clear();
    if ( this.radius > 0 ) c.fov.beginFill(0xFFFFFF, 1.0).drawPolygon(this.fov).endFill();
    return c;
  }

  limitView(rays, len) {
    const points = [];
    for ( let r of rays ) {
      points.push(len < r.distance ? r.project(len / r.distance) : { x: r.B.x, y: r.B.y, t0: 1, t1: 0});
    }
    return new PIXI.Polygon(...points);
  }
}

PointSource.prototype.drawColor = function() {
  const hasColor = this.color && (this.alpha > 0);
  if ( !hasColor && !this.darkness ) return null;
  const c = this.coloration;
  const l = c.light;

  // Define common radius and dimensions
  l.position.set(this.x, this.y);
  l.width = l.height = this.radius * 2;

  // Reset uniforms
  const cu = c.shader.uniforms;
  cu.darkness = this.darkness;
  cu.alpha = this.alpha;
  cu.color = this.colorRGB;

  // Draw the masking FOV polygon
  c.fov.clear();
  if ( this.radius > 0 ) c.fov.beginFill(0xFFFFFF, 1.0).drawPolygon(this.fov).endFill();
  return c;
};

Token.prototype.updateSource = function({defer=false, deleted=false, noUpdateFog=false}={}) {
  if ( CONFIG.debug.sight ) {
    SightLayer._performance = { start: performance.now(), tests: 0, rays: 0 }
  }

  // Prepare some common data
  const origin = this.getSightOrigin();
  const sourceId = this.sourceId;
  const d = canvas.dimensions;
  const maxR = canvas.lighting.globalLight ? Math.max(d.sceneWidth, d.sceneHeight) : null;

  // Update light source
  const isLightSource = this.emitsLight && !this.data.hidden && !deleted;
  if ( isLightSource ) {
    const bright = this.getLightRadius(this.data.brightLight);
    const dim = this.getLightRadius(this.data.dimLight);
    this.light.initialize({
      x: origin.x,
      y: origin.y,
      dim: dim,
      bright: bright,
      angle: this.data.lightAngle,
      rotation: this.data.rotation,
      color: this.data.lightColor,
      alpha: this.data.lightAlpha,
      animation: this.data.lightAnimation
    });
    canvas.lighting.sources.set(sourceId, this.light);
    if ( !defer ) {
      this.light.drawLight();
      this.light.drawColor();
    }
  }
  else canvas.lighting.sources.delete(sourceId);

  // Update vision source
  const isVisionSource = this._isVisionSource() && !deleted;
  if ( isVisionSource ) {
    if (!(this.vision instanceof ViewPointSource)) {
      this.vision = new ViewPointSource();
    }

    let dim = maxR ? maxR : this.getLightRadius(this.data.dimSight);
    const bright = this.getLightRadius(this.data.brightSight);
    const devil = this.getLightRadius(this.getFlag('darkness_5e', 'devilSight') || 0);
    if ((dim === 0) && (bright === 0)) dim = d.size * 0.6;
    this.vision.initialize({
      x: origin.x,
      y: origin.y,
      dim: dim,
      bright: bright,
      devil: devil,
      angle: this.data.sightAngle,
      rotation: this.data.rotation
    });
    canvas.sight.sources.set(sourceId, this.vision);
    if ( !defer ) {
      this.vision.drawLight();
      canvas.sight.refresh({noUpdateFog});
    }
  }
  else canvas.sight.sources.delete(sourceId);
}
overrideMethod(Token.prototype, '_onUpdate', function(base) {
  return function(data, options, userId) {
    if (data.flags && data.flags.darkness_5e && data.flags.darkness_5e.devilSight && !(data.dimSight || data.brightSight)) {
      data.dimSight = this.data.dimSight;
    }
    return base.call(this, data, options, userId);
  }
});

LightingLayer.prototype._drawIlluminationContainer = function() {
    const c = new PIXI.Container();
    const bgContainer = c.addChild(new PIXI.Container());
    c.background = bgContainer.addChild(new PIXI.Graphics());
    c.background_mask = bgContainer.addChild(new PIXI.Graphics());
    c.lights = c.addChild(new PIXI.Container());
    c.lights.sortableChildren = true;
    c.filter = this._blurDistance ?
      new PIXI.filters.BlurFilter(this._blurDistance) :
      new PIXI.filters.AlphaFilter(1.0);
    c.filter.blendMode = PIXI.BLEND_MODES.MULTIPLY;
    c.filters = [c.filter];
    c.filterArea = canvas.app.renderer.screen;
    return c;
  }
SightLayer.prototype.cutout = function(outer, inner, g) {
  const points = [];
  const hidxs = [];
  points.push(outer);
  hidxs.push(points.length / 2);
  points.push(inner);
  const indices = PIXI.utils.earcut(points, hidxs, 2);
  for (let i = 0; i < indices; i += 3) {
    g.moveTo(points[2 * i    ], points[2 * i + 1]);
    g.lineTo(points[2 * i + 2], points[2 * i + 3]);
    g.lineTo(points[2 * i + 4], points[2 * i + 5]);
  }
}
overrideMethod(SightLayer.prototype, 'refresh', function(base) {
  return function(darkness) {
    base.call(this, darkness);
    const mask = canvas.lighting.illumination.background_mask;
    mask.clear();
    mask.beginFill(0x808080, 1.0);
    for ( let source of canvas.sight.sources ) {
      if (source.dimFov && source.devil > source.dim) {
        this.cutout(source.fov, source.dimFov, mask);
      }
    }
    mask.endFill();
  }
});
SightLayer.computeSight = Darkness5e.computeSight;

LightingLayer.prototype.refresh = function(darkness) {
    darkness = darkness ?? canvas.lighting.darknessLevel;
    this.channels = this._configureChannels(darkness);
    let refreshVision = false;

    // Toggle global illumination
    const sd = canvas.scene.data;
    var changed = this.darknessLevel !== darkness;
    if ( sd.globalLight && (sd.globalLightThreshold !== null) ) {
      const globalLight = darkness <= sd.globalLightThreshold;
      changed ||= globalLight !== this.globalLight;
      this.globalLight = globalLight;
    }
    this.darknessLevel = darkness;
    if ( changed ) {
      canvas.tokens.controlled.forEach(t => t.updateSource({defer: true}));
      refreshVision = true;
    }

    // Clear currently rendered sources
    const ilm = this.illumination;
    ilm.lights.removeChildren();
    const col = this.coloration;
    col.removeChildren();
    this._animatedSources = [];

    // Tint the background color
    canvas.app.renderer.backgroundColor = this.channels.canvas.hex;
    ilm.background.tint = this.channels.background.hex;

    // Render light sources
    for ( let sources of [this.sources, canvas.sight.sources] ) {
      for ( let source of sources ) {

        // Check the active state of the light source
        const isActive = source.darknessThreshold <= darkness;
        if ( source.active !== isActive ) refreshVision = true;
        source.active = isActive;
        if ( !source.active ) continue;

        // Draw the light update
        const sc = source.drawLight(this.channels);
        ilm.lights.addChild(sc);
        const color = source.drawColor();
        if ( color ) col.addChild(color);
        if ( source.animation?.type ) this._animatedSources.push(source);
      }
    }

    // Refresh vision if necessary
    if ( refreshVision ) canvas.sight.refresh();

    // Dispatch a hook that modules can use
    Hooks.callAll("lightingRefresh", this);
  }
overrideMethod(MeasuredTemplate.prototype, "refresh", function(base) {
  return async function() {
    base.call(this);
    if (this.data && this.data.flags && this.data.flags.darkness_5e && this.data.flags.darkness_5e.darkness) {
      this.template.clear();
      this.template.beginFill(0x000000, 0.5);
      this.template.drawShape(this.shape);
      this.template.endFill();
      this.ruler.visible = false;
      this.controlIcon.icon.texture = await loadTexture('modules/conditional-visibility/icons/moon.svg');
      
      canvas.grid.getHighlightLayer(`Template.${this.id}`).clear();
    }
    else {
      this.ruler.visible = true;
      this.controlIcon.icon.texture = await loadTexture(CONFIG.controlIcons.template);
    }
  }
});
overrideMethod(Wall.prototype,"_onModifyWall", function(base) {
  return function(...args) {
    base.call(this, ...args);
    for ( let source of canvas.sight.sources ) {
      canvas.sight.updateFog(source, true);
    }
    if ( canvas.sight._fogUpdates >= SightLayer.FOG_COMMIT_THRESHOLD ) canvas.sight.commitFog();
    if ( canvas.sight._fogUpdated ) canvas.sight.debounceSaveFog();
  }
});
