# set_prototypes.py — the per-track landmarks, built in headless Blender:
# procedural primitives (there is no kit model for a ski lift or a slinky) with
# Kenney kit pieces imported where one fits. The primitives speak the grammar
# the game's cars are built in (scripts/toy_cars.py): chunky blocks with one
# small chamfer on every edge (chamfer), a pole, rail or rope is a square bar
# (BAR), the kit's palette with one gradient over the whole piece, light on top
# (paint, shade). Only what is round in life stays round: drums, wheels,
# canopies. One GLB per piece, in the set-piece
# frame the renderer places (gen-set-pieces.mjs: origin at the spot, +Z along the
# track's direction of travel, +X across, y = 0 the ground). The FRONT of a piece
# faces +X: placed on the track's right (lat > 0) at yaw 0 that is the road side,
# on the left use yaw 180.
#
# Each track has a HERO piece (its landmark proper) and a SUPPORT piece (a
# smaller second scene elsewhere on the lap); both are listed in the track's
# `set` in tracks.js. Every builder authors at a toy scale a car can be stood
# against (a car is ~1.8 long, the road 5 wide) and GROW scales the whole piece
# at export, so a landmark reads from the chase cam at the far side of a lap.
#
# Driven by scripts/gen-set-prototypes.mjs, which grafts each kit's atlas back
# onto the `tex:<kit>` materials this leaves (Blender's exporter writes no images
# here) and stages the result under public/assets/toycar.
#
#   blender -b -P scripts/blender/set_prototypes.py -- <kitCache> <outDir> [name ...]
#
# Blender is Z-up and the exporter maps (x, y, z) -> (x, z, -y), so every helper
# takes glTF coordinates (across, up, along) and converts once, in `P()`.
import contextlib
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:]
KIT_CACHE, OUT_DIR = argv[0], argv[1]
ONLY = set(argv[2:])

# ---- frame + colour -----------------------------------------------------------

def P(x, y, z):
    """glTF (across, up, along) -> Blender (x, y, z)."""
    return Vector((x, -z, y))

# Kenney colours its kits from one small atlas (the toy-car kit's
# Textures/colormap.png): a row of swatches, each a flat half and a RAMP half
# that darkens from top to bottom. A procedural part takes the swatch nearest
# the colour its builder asked for, and shade() runs the whole piece down the
# ramp by height, light on top, as the cars are. The swatch is (x, y) of its
# top-left pixel in the 128 px atlas; the ramp is x + 8 .. x + 15.
SWATCH = {
    'cream': (0, 64), 'green': (16, 64), 'yellow': (32, 64), 'orange': (48, 64),
    'red': (64, 64), 'blue': (80, 64), 'sky': (96, 64), 'purple': (112, 64),
    'dark': (0, 96), 'grey': (16, 96), 'slate': (32, 96), 'lavender': (48, 96),
    'white': (64, 96), 'salmon': (80, 96), 'brown': (96, 96), 'tan': (112, 96),
    'pink': (0, 32),
    # Ours, painted into the atlas's unused rows for the park's cherries: by
    # NAME only (not in SWATCH_RGB), so no other piece's colour snaps to them.
    'blossom': (16, 32), 'petal': (32, 32), 'bark': (48, 32), 'leaf': (64, 32), 'gravel': (80, 32),
    # and the canyon's plants, the same way: a saguaro's dusty grey-green and
    # the dry olive of creosote (the kit's `green` is a lawn's)
    'sage': (96, 32), 'olive': (112, 32),
}
SWATCH_RGB = {
    'cream': 0xfde4c7, 'green': 0x61cb8b, 'yellow': 0xffc044, 'orange': 0xff7e44,
    'red': 0xcf534f, 'blue': 0x6794d9, 'sky': 0xd0e8ff, 'purple': 0xa878e8,
    'dark': 0x38383d, 'grey': 0x868ba1, 'slate': 0x4f5260, 'lavender': 0xa0a8c9,
    'white': 0xffffff, 'salmon': 0xf1976c, 'brown': 0xb06041, 'tan': 0xf2bf99,
    'pink': 0xf378f0,
}
# where the nearest swatch reads wrong: water is blue, snow is white, glass is sky
SNAP = {0x62d3c8: 'sky', 0x8ecae6: 'sky', 0x7db8e8: 'blue', 0xe9eff6: 'white',
        0xd9b054: 'yellow', 0x6e5b3a: 'brown', 0x7d6f5f: 'grey', 0xb8a686: 'tan',
        0xcbb794: 'cream'}

def snap(color):
    """A swatch name, or the swatch nearest a hex colour (redmean distance)."""
    if isinstance(color, str):
        return color
    if color in SNAP:
        return SNAP[color]
    def d(k):
        a, b = color, SWATCH_RGB[k]
        r1, g1, b1, r2, g2, b2 = a >> 16 & 255, a >> 8 & 255, a & 255, b >> 16 & 255, b >> 8 & 255, b & 255
        rm = (r1 + r2) / 2
        return (2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2
    return min(SWATCH_RGB, key=d)

ATLAS = 'tex:toy-car'   # the driver grafts the kit's colormap onto this name
RAMP = 20   # px of the 32 px ramp a piece spans: the full run greys a white wall

def atlas_material():
    m = bpy.data.materials.get(ATLAS)
    if m is None:
        m = bpy.data.materials.new(ATLAS)
        m.use_nodes = True
    return m

def paint(obj, color):
    """Give `obj` the atlas and its swatch; shade() maps it once the piece stands."""
    me = obj.data
    me.materials.clear()
    me.materials.append(atlas_material())
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    obj['swatch'] = snap(color)
    return obj

def shade():
    """Every painted part down its swatch's ramp by WORLD height over the whole
    piece, as a car is shaded over the car: the roof light, the plinth dark.
    A UV that depends on the vertex alone also lets the chamfer share it.
    A part marked `ramp` (snowy()) runs only that share of it: lying snow
    greyed to lavender at the foot of a tall piece reads as stone."""
    bpy.context.view_layer.update()
    parts = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.get('swatch')]
    if not parts:
        return
    top = max(max((o.matrix_world @ v.co).z for v in o.data.vertices) for o in parts) or 1.0
    for o in parts:
        me, (x, y) = o.data, SWATCH[o['swatch']]
        uv, k = me.uv_layers[0], o.get('ramp', 1.0)
        row = o.get('row')                        # rowed(): one shade off the ramp, whatever the height
        for loop in me.loops:
            f = max(0.0, min(1.0, (o.matrix_world @ me.vertices[loop.vertex_index].co).z / top))
            r = row if row is not None else (1 - f) * RAMP * k
            uv.data[loop.index].uv = ((x + 12) / 128, 1 - (y + 0.5 + r) / 128)

# ---- primitives (glTF frame) ---------------------------------------------------

def place(obj, at, yaw=0.0, pitch=0.0, roll=0.0):
    obj.location = P(*at)
    # yaw about up (= Blender Z, same sign); pitch tips the +Z (along) axis up,
    # a rotation about Blender X by -pitch; roll tips +X up, about Blender Y.
    obj.rotation_euler = (-pitch, roll, yaw)
    return obj

# Nothing thinner than MIN_T (a plate, a stripe); a pole, a rail, a rung or a
# rope is a square bar at least BAR across, the cars' "no thin rods" at this
# scale: a car's bars are an eighth of its body's width, so a landmark's are
# fatter than the car's own.
MIN_T = 0.06
BAR = 0.2

def box(size, at, color, yaw=0.0, pitch=0.0, roll=0.0):
    """size = (across, up, along), centred at `at`."""
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    o = bpy.context.active_object
    size = [max(s, MIN_T) for s in size]
    o.scale = (size[0], size[2], size[1])
    o['chamfer'] = 1
    place(o, at, yaw, pitch, roll)
    return paint(o, color)

def cyl(r, h, at, color, r2=None, segs=8, axis='up', yaw=0.0, smooth=False, stem=False):
    """A cylinder (or cone when r2 differs) whose base centre is `at`, standing
    along `axis` (up | along | across). Faceted, like a Kenney barrel; a thin
    one longer than four radii is a pole, built as the cars' square bar (a log
    or a trunk stays round: `stem`, a living thing's round body)."""
    pole = h > 4 * r and r <= 0.25 and not stem
    if pole:
        # a square of side 2r has its corners at r * sqrt(2)
        r = max(r, BAR / 2) * math.sqrt(2)
        r2 = None if r2 is None else max(r2, BAR / 3) * math.sqrt(2)
        segs, smooth = 4, False
    bpy.ops.mesh.primitive_cone_add(vertices=segs, radius1=r, radius2=r if r2 is None else r2,
                                    depth=h, end_fill_type='NGON')
    o = bpy.context.active_object
    for v in o.data.vertices:
        v.co.z += h / 2
        if pole:
            v.co.x, v.co.y = (v.co.x - v.co.y) / math.sqrt(2), (v.co.x + v.co.y) / math.sqrt(2)
    if pole:
        o['chamfer'] = 1
    if axis == 'along':
        o.rotation_euler = (math.radians(90), 0, 0)   # local Z -> Blender -Y (glTF +Z)
    elif axis == 'across':
        o.rotation_euler = (0, math.radians(90), 0)   # local Z -> Blender +X
    o.location = P(*at)
    if yaw:
        o.rotation_euler.z += yaw
    if smooth:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
    return paint(o, color)

def tilted(obj, tx, ty):
    """Tip an up-standing object: tx about Blender X, ty about Blender Y."""
    obj.rotation_euler = (tx, ty, obj.rotation_euler.z)
    return obj

def sphere(r, at, color, subdiv=1, scale=(1, 1, 1), flat=True, yaw=0.0):
    # Faceted, as Kenney's are, but a flat face costs three vertices of its
    # own: nothing goes past one split, and a knob or an eye is a block, as
    # a car's lamp is.
    if flat and r * max(scale) < 0.35:
        return box([1.6 * r * k for k in scale], at, color, yaw=yaw)
    if flat:
        subdiv = min(subdiv, 1)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=r)
    o = bpy.context.active_object
    o.scale = (scale[0], scale[2], scale[1])
    o.location = P(*at)
    o.rotation_euler = (0, 0, yaw)
    if flat:
        bpy.ops.object.shade_flat()
    else:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
    return paint(o, color)

def torus(R, r, at, color, segs=12, minor=6, axis='up', yaw=0.0):
    """A ring; a thin one is the cars' square bar bent round."""
    if r <= 0.25:
        r, minor = max(r, BAR / 2) * math.sqrt(2), 4
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=segs, minor_segments=minor)
    o = bpy.context.active_object
    if axis == 'along':
        o.rotation_euler = (math.radians(90), 0, 0)
    elif axis == 'across':
        o.rotation_euler = (0, math.radians(90), 0)
    o.location = P(*at)
    o.rotation_euler.z += yaw
    bpy.ops.object.shade_flat()
    return paint(o, color)

def disc(r, at, color, segs=24, h=0.04):
    return cyl(r, h, at, color, segs=segs, smooth=False)

def terrain(height, x0, x1, nx, z0, z1, nz, color):
    """A faceted heightfield (a hill, a bank): `height(x, z)` sampled on an
    nx-by-nz grid in the piece frame. Flat faces, no chamfer, like the kit's
    own snow and rock."""
    xs = [x0 + (x1 - x0) * i / (nx - 1) for i in range(nx)]
    zs = [z0 + (z1 - z0) * j / (nz - 1) for j in range(nz)]
    verts = [P(x, height(x, z), z) for z in zs for x in xs]
    faces = [(j * nx + i, j * nx + i + 1, (j + 1) * nx + i + 1, (j + 1) * nx + i)
             for j in range(nz - 1) for i in range(nx - 1)]
    me = bpy.data.meshes.new('terrain')
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    if me.polygons[0].normal.z < 0:
        for p in me.polygons:
            p.flip()
    o = bpy.data.objects.new('terrain', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

def poly(verts, faces, color):
    """Raw faces in the piece frame (a fold of paper, a fin), each drawn from
    both sides so a thin sheet never vanishes from behind."""
    me = bpy.data.meshes.new('poly')
    faces = list(faces) + [tuple(reversed(f)) for f in faces]
    me.from_pydata([tuple(P(*v)) for v in verts], [], faces)
    me.update()
    o = bpy.data.objects.new('poly', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

def rowed(o, row):
    """Fix `o` at one row (0-31) of its swatch's ramp, top to bottom: a shade
    the swatch's own colour does not give (the sky ramp's water blues, the
    grey ramp's lifted slate), the same at every height."""
    o['row'] = row
    return o

def skin(verts, faces, color, out):
    """One-sided faces (a sheet of water on rock), each turned to face `out`
    (a glTF direction): poly()'s two-sided sheet would fight the rock it
    lies on for the depth test."""
    me = bpy.data.meshes.new('skin')
    me.from_pydata([tuple(P(*v)) for v in verts], [], faces)
    me.update()
    o_ = P(*out)
    for f in me.polygons:
        if f.normal.dot(o_) < 0:
            f.flip()
    o = bpy.data.objects.new('skin', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

def prism(outline, x, t, color):
    """A flat board cut to `outline` [(z, y), ...] (counter-clockwise seen from
    +X), `t` thick, centred on `x`: a surfboard, a sign cut to shape."""
    n = len(outline)
    verts = [(x + t / 2, y, z) for z, y in outline] + [(x - t / 2, y, z) for z, y in outline]
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    faces += [(i, n + i, n + (i + 1) % n, (i + 1) % n) for i in range(n)]
    me = bpy.data.meshes.new('prism')
    me.from_pydata([tuple(P(*v)) for v in verts], [], faces)
    me.update()
    o = bpy.data.objects.new('prism', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

def tube(points, r, color, res=4, bevel_res=1, closed=False, smooth=False, wire=False):
    """A bar swept along a smooth curve through glTF `points`: a thin one is
    square in section (a rope, a hose) unless `smooth` keeps it round; a trunk
    stays round. A `wire` (a telegraph wire, a lift cable) keeps its own thin
    radius: at the BAR floor it reads as a pipe."""
    if not wire:
        r = max(r, BAR / 2)
    if not smooth and r <= 0.25:
        r, bevel_res = r * math.sqrt(2), 0
    curve = bpy.data.curves.new('tube', 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = res
    curve.bevel_depth = r
    curve.bevel_resolution = bevel_res
    curve.use_fill_caps = True
    sp = curve.splines.new('NURBS')
    sp.points.add(len(points) - 1)
    for p, (x, y, z) in zip(sp.points, points):
        b = P(x, y, z)
        p.co = (b.x, b.y, b.z, 1.0)
    sp.use_endpoint_u = True
    sp.order_u = min(4, len(points))
    sp.use_cyclic_u = closed
    o = bpy.data.objects.new('tube', curve)
    bpy.context.scene.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.convert(target='MESH')
    o = bpy.context.active_object
    if smooth:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
    else:
        bpy.ops.object.shade_flat()
    return paint(o, color)

def sag(a, b, drop, n=9):
    """Points of a sagging line from glTF point a to b."""
    pts = []
    for i in range(n):
        t = i / (n - 1)
        pts.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - drop * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t))
    return pts

def kit(kit_id, model, at, yaw=0.0, scale=1.0, pitch=0.0, roll=0.0):
    """Import one kit model, joined into one object. A textured material is
    renamed `tex:<kit>` so the driver can graft the atlas back; an untextured
    one keeps its flat baseColorFactor."""
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(KIT_CACHE, kit_id, 'models', model + '.glb'))
    new = [o for o in bpy.context.scene.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    empties = [o for o in new if o.type != 'MESH']   # listed now: join() frees mesh objects
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    for e in empties:
        bpy.data.objects.remove(e, do_unlink=True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for m in o.data.materials:
        textured = m.node_tree and any(n.type == 'TEX_IMAGE' for n in m.node_tree.nodes)
        if textured:
            name = 'tex:' + kit_id
            if name in bpy.data.materials:
                idx = list(o.data.materials).index(m)
                o.data.materials[idx] = bpy.data.materials[name]
            else:
                m.name = name
    o.name = '%s_%s' % (kit_id, model)
    o.scale = (scale, scale, scale)
    o.rotation_mode = 'XYZ'   # the importer leaves QUATERNION, where place()'s euler turn is ignored
    place(o, at, yaw, pitch, roll)
    return o

# ---- moving parts ------------------------------------------------------------------
# A part that moves is ONE object named `anim_<verbs>` with its origin at its
# pivot: native/libttp-runtime/ttp/set_motion.h is the grammar, the renderer
# bakes and moves it (TtpRendererMotion.cpp). Build its pieces inside
# `with animated(name, pivot):`; finalize_and_export joins them after the
# chamfer, so the part costs one draw and keeps the piece's look. Names must be
# unique in a piece (Blender would suffix a repeat), so a repeated part carries
# a `#n` tag the grammar ignores. The motion's axes are the NODE's: a part built
# turned by `yaw` (a penguin facing its own way) passes it, and the node carries
# the turn, so a watch clamps about its beak and a waddle rocks over its feet.
# An `animated` block inside another is a part riding on that one (a key
# turning in a walking robot's back): its node is exported as the outer
# node's child, and the renderer moves it in the outer one's moving frame.
# `tilt` leans a part's node about x (a spinning top's axis, off upright, for
# it to precess round the upright spin of the part it rides): build its
# pieces upright and the block leans them, its riders' too, about the pivot.

ANIMS = []
ANIM_STACK = []

def animate(objs, name, pivot, yaw=0.0):
    """Mark built objects as one moving part (what `animated` does for a block)."""
    gid = len(ANIMS)
    ANIMS.append((name, pivot, yaw, None, 0.0))
    for o in objs:
        o['anim'] = gid

class animated:
    def __init__(self, name, pivot, yaw=0.0, tilt=0.0):
        self.name, self.pivot, self.yaw, self.tilt = name, pivot, yaw, tilt
    def __enter__(self):
        self.before = set(bpy.context.scene.objects)
        self.gid = len(ANIMS)
        ANIMS.append((self.name, self.pivot, self.yaw, ANIM_STACK[-1] if ANIM_STACK else None, self.tilt))
        ANIM_STACK.append(self.gid)
        return self
    def __exit__(self, *exc):
        ANIM_STACK.pop()
        new = [o for o in bpy.context.scene.objects if o not in self.before]
        for o in new:
            if o.get('anim') is None:   # an inner part keeps its own
                o['anim'] = self.gid
        if self.tilt:
            bpy.context.view_layer.update()   # the newest part's matrix_world is not current yet
            lean = Matrix.Translation(P(*self.pivot)) @ Matrix.Rotation(self.tilt, 4, 'X') \
                @ Matrix.Translation(-P(*self.pivot))
            for o in new:
                if o.parent is None:
                    o.matrix_world = lean @ o.matrix_world
        return False

def split_off(o, pick):
    """Separate the faces of `o` whose local centre passes `pick` into their
    own object, and return it (a kit flag's cloth off its pole)."""
    import bmesh
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bm = bmesh.from_edit_mesh(o.data)
    for f in bm.faces:
        if pick(f.calc_center_median()):
            f.select_set(True)
    bm.select_flush(True)
    bmesh.update_edit_mesh(o.data)
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    return next(x for x in bpy.context.selected_objects if x is not o)

def kit_flag(model, at, yaw, scale, flap):
    """A kit flag whose cloth flaps: it dips and lifts about the cloth's own
    normal, hinged at the top of the pole. Seen across, which is how a car sees
    a flag turned to the road, that reads; a swing round the pole only narrows
    the cloth. The pole stays in the static bake."""
    o = kit('pirate', model, at, yaw=yaw, scale=scale)
    cloth = split_off(o, lambda c: c.x > 0.25)   # the kit's cloth flies along its +X off a 0.2 pole
    bpy.context.view_layer.update()
    top = max((cloth.matrix_world @ v.co).z for v in cloth.data.vertices)
    animate([cloth], flap, (at[0], top, at[2]))

def marker(name, at):
    """A mesh-less node: a path's waypoint (`path_<chain>_<k>`, a closed loop
    in k order) or where something happens (`anim_smoke`)."""
    o = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(o)
    o.location = P(*at)
    return o

def join_anims(k):
    """Each `animated` group into one object, origin at its pivot (grown by k
    with the piece), rotation and scale applied so its frame is the piece's."""
    joined = {}
    for gid, (name, pivot, yaw, _, tilt) in enumerate(ANIMS):
        objs = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.get('anim') == gid]
        if not objs:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.convert(target='MESH')          # applies the chamfer
        if len(objs) > 1:
            bpy.ops.object.join()
        o = bpy.context.view_layer.objects.active
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bpy.context.scene.cursor.location = P(*pivot) * k
        bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
        if yaw or tilt:   # the turn moves from the vertices onto the node (yaw about up = Blender Z)
            o.data.transform((Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(tilt, 4, 'X')).inverted())
            o.rotation_euler = (tilt, 0.0, yaw)
        o.name = name
        o.data.name = name
        joined[gid] = o
    bpy.context.view_layer.update()
    for gid, (_, _, _, parent, _) in enumerate(ANIMS):
        if parent is not None and gid in joined and parent in joined:
            child, over = joined[gid], joined[parent]
            child.parent = over
            child.matrix_parent_inverse = over.matrix_world.inverted()
    ANIMS.clear()

# ---- shared sub-assemblies ------------------------------------------------------

def flagpole(at, h, color, w=1.2, fh=0.7, pole=0xfff6eb, wave=None):
    """`wave` names the cloth's motion (a `#n` tag apart per flag), hinged at
    the top of the pole: a flap about z (the cloth's normal) dips and lifts it,
    which is what reads from a car seeing it across (kit_flag)."""
    x, y, z = at
    cyl(0.2, 0.3, (x, y, z), pole, segs=6)
    cyl(0.09, h, (x, y, z), pole, segs=6)
    sphere(0.17, (x, y + h + 0.1, z), pole, subdiv=1)
    # the cloth in two slabs, kinked as if the wind had it
    def cloth():
        box((w * 0.55, fh, 0.12), (x + w * 0.27 + 0.05, y + h - fh / 2 - 0.1, z), color)
        box((w * 0.5, fh * 0.9, 0.12), (x + w * 0.77, y + h - fh / 2 - 0.15, z + 0.08), color, yaw=-0.3)
    if wave:
        with animated(wave, (x, y + h, z)):
            cloth()
    else:
        cloth()

def post_and_rail(a, b, h, color, r=0.06):
    cyl(r, h, a, color, segs=6, smooth=False)
    cyl(r, h, b, color, segs=6, smooth=False)
    tube([(a[0], a[1] + h, a[2]), (b[0], b[1] + h, b[2])], r * 0.8, color, res=2, bevel_res=0)

def bench(at, yaw=0.0, color=0x9a7b55):
    """A park bench; whoever sits on it faces the piece's +Z turned by `yaw`."""
    box((1.6, 0.08, 0.5), (at[0], at[1] + 0.5, at[2]), color, yaw=yaw)
    box((1.6, 0.5, 0.08), (at[0] - 0.22 * math.sin(yaw), at[1] + 0.85, at[2] - 0.22 * math.cos(yaw)), color, yaw=yaw)
    for s in (-0.65, 0.65):
        box((0.08, 0.5, 0.5), (at[0] + s * math.cos(yaw), at[1] + 0.25, at[2] - s * math.sin(yaw)), 0x555b66, yaw=yaw)

def hut(w, h, d, at, wall, roof, yaw=0.0, t=1.0):
    """A little gabled hut, door on +X, dressed as a car is: a grey plinth, a
    dark door and windows standing proud in white frames, a chunky roof under
    a grey ridge. `t` scales the dressing (plinth, frames, roof) for a hut at
    real size beside a car, a fifth of the toy-scale one's."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def part(dx, dy, dz, size, color, pitch=0.0):   # offset in the hut's own frame
        box(size, (x + dx * c + dz * s, y + dy, z - dx * s + dz * c), color, yaw=yaw, pitch=pitch)
    part(0, h / 2, 0, (w, h, d), wall)
    part(0, 0.15 * t, 0, (w + 0.2 * t, 0.3 * t, d + 0.2 * t), 'grey')
    dw = min(d * 0.4, 0.9 * t)
    part(w / 2 + 0.04 * t, h * 0.36, 0, (0.1 * t, h * 0.72 + 0.12 * t, dw + 0.24 * t), 'white')
    part(w / 2 + 0.1 * t, h * 0.33, 0, (0.1 * t, h * 0.66, dw), 'slate')
    for k in (-1, 1):
        part(0, h * 0.58, k * (d / 2 + 0.04 * t), (w * 0.42 + 0.2 * t, h * 0.3 + 0.2 * t, 0.1 * t), 'white')
        part(0, h * 0.58, k * (d / 2 + 0.1 * t), (w * 0.42, h * 0.3, 0.1 * t), 'slate')
        part(0, h + 0.3 * t, k * (d + 0.5 * t) / 4, (w + 0.5 * t, 0.24 * t, (d + 0.5 * t) * 0.55), roof, pitch=-k * 0.6)
    part(0, h + 0.3 * t + 0.155 * (d + 0.5 * t) + 0.08 * t, 0, (w + 0.6 * t, 0.22 * t, 0.34 * t), 'grey')

def boulder(at, k=1.0, yaw=0.0, color='grey', squash=0.7):
    """A shore boulder, the Pirate Kit's grey rock: one faceted lump, wider
    than tall, its foot bedded in the sand."""
    return sphere(k, (at[0], at[1] + k * squash * 0.55, at[2]), color, subdiv=1,
                  scale=(1.25, squash, 1.0), yaw=yaw)

def beam(a, b, w, color, d=None):
    """A square bar from glTF point a to b, `w` across (`d` the other way)."""
    pa, pb = P(*a), P(*b)
    v = pb - pa
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    o = bpy.context.active_object
    o.scale = (max(w, MIN_T), max(d or w, MIN_T), v.length)
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = v.to_track_quat('Z', 'Y')
    o.location = (pa + pb) / 2
    o['chamfer'] = 1
    return paint(o, color)

def rod(a, b, r, color, r2=None, segs=7):
    """A round log from glTF point a to b, tapering to r2."""
    pa, pb = P(*a), P(*b)
    v = pb - pa
    bpy.ops.mesh.primitive_cone_add(vertices=segs, radius1=r, radius2=r if r2 is None else r2,
                                    depth=v.length, end_fill_type='NGON')
    o = bpy.context.active_object
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = v.to_track_quat('Z', 'Y')
    o.location = (pa + pb) / 2
    return paint(o, color)

def snow_heap(at, k=1.0, yaw=0.0):
    """A drift of snow: two soft slabs, the kit's snow pile at a tenth of it."""
    x, y, z = at
    snowy(box((1.4 * k, 0.5 * k, 1.1 * k), (x, y + 0.25 * k, z), 0xf3f7fb, yaw=yaw))
    snowy(box((0.9 * k, 0.35 * k, 0.7 * k), (x + 0.1 * k, y + 0.6 * k, z), 0xf3f7fb, yaw=yaw + 0.5))

def pine(at, k=1.0):
    """A snowy fir of size `k`: the Holiday Kit's (kit_fir), as tall as the
    stacked-tier pine this was."""
    kit_fir('a', at, 1.9 * k)

def rock(at, k=1.0, yaw=0.0, color=0x868ba1):
    """A grey rock: two blocks, one tipped on the other."""
    x, y, z = at
    box((1.2 * k, 0.8 * k, 1.0 * k), (x, y + 0.4 * k, z), color, yaw=yaw)
    box((0.7 * k, 0.5 * k, 0.6 * k), (x + 0.2 * k, y + 0.95 * k, z - 0.1 * k), 0x9aa1b4, yaw=yaw + 0.6)

def dead_tree(at, h=6.0, color=0x8a6a46, r=0.45):
    """A dead tree `h` tall, its trunk `r` at the foot, four bare limbs in
    proportion to it."""
    x, y, z = at
    k = h / 6.0
    cyl(r, h, (x, y, z), color, r2=r * 0.45, segs=7, smooth=False)
    for i, (a, t, l) in enumerate(((0.3, 0.55, 2.8), (2.4, 0.5, 2.4), (4.2, 0.65, 2.0), (1.4, 0.95, 1.6))):
        o = cyl(r * 0.36, l * k, (x, y + h * (0.55 + 0.12 * i), z), color, r2=r * 0.09, segs=5, smooth=False)
        tilted(o, math.cos(a) * t, math.sin(a) * t)

# ---- the pieces ----------------------------------------------------------------

PIECES = {}
GROW = {}
def piece(grow=1.0):
    def wrap(fn):
        name = fn.__name__.replace('_', '-')
        PIECES[name] = fn
        GROW[name] = grow
        return fn
    return wrap

# ====================================================================================
# BEACH
# ====================================================================================

# Every beach piece stands at the size a car makes it (a car is 0.9 long, so
# 1 u is about 4.5 m): a person is half a car long, an umbrella a little over
# a car's height, a lifeguard tower two. Only what is big in life is big here:
# the reef and its pool, a ship, the headland. These builders author in world
# units and grow 1; the reef alone keeps its toy-scale build grown.

# ---- the beach's people, birds and gear ----

def figure(at, yaw=0.0, shirt=0xff5040, legs=0x339cf2, skin=0xf2bf99, hair=0x7a5a3a, pose='stand'):
    """A person half a car long, facing +X turned by `yaw`, in blocks as the
    cars' drivers are: `stand`, `sit` (on the sand, legs out to +X), `crouch`
    or `lie` (on the back, head to -X)."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def b(size, dx, dy, dz, color):
        box(size, (x + dx * c + dz * s, y + dy, z - dx * s + dz * c), color, yaw=yaw)
    if pose == 'stand':
        b((0.08, 0.2, 0.16), 0, 0.1, 0, legs)
        b((0.1, 0.17, 0.24), 0, 0.285, 0, shirt)                          # shoulders and arms
        b((0.11, 0.11, 0.11), 0, 0.43, 0, skin)
        b((0.12, 0.04, 0.12), -0.01, 0.5, 0, hair)
    elif pose in ('sit', 'crouch'):
        if pose == 'sit':
            b((0.22, 0.07, 0.15), 0.08, 0.035, 0, legs)                    # legs out
        else:
            b((0.12, 0.14, 0.15), 0.05, 0.07, 0, legs)                     # knees up
        b((0.1, 0.17, 0.2), -0.05, 0.155, 0, shirt)
        b((0.11, 0.11, 0.11), -0.03, 0.3, 0, skin)
        b((0.12, 0.04, 0.12), -0.04, 0.37, 0, hair)
    else:
        b((0.22, 0.06, 0.15), 0.17, 0.03, 0, legs)
        b((0.17, 0.08, 0.2), -0.03, 0.04, 0, shirt)
        b((0.1, 0.09, 0.1), -0.17, 0.045, 0, skin)

def gull(at, yaw=0.0, life=None):
    """A gull standing on its feet, facing +X turned by `yaw`, 0.16 tall
    (twice a gull beside a car, so it reads at all): white body and head, a
    grey back, a yellow bill. `life` names its motion (set_motion.h),
    pivoting between its feet: watching the cars, hopping off as one passes."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def b(size, dx, dy, dz, color):
        box(size, (x + dx * c + dz * s, y + dy, z - dx * s + dz * c), color, yaw=yaw)
    def build():
        b((0.06, 0.06, 0.06), 0, 0.03, 0, 0xff7e44)                          # legs
        b((0.16, 0.07, 0.09), -0.01, 0.09, 0, 0xf8f8fb)                      # body
        b((0.13, 0.03, 0.1), -0.04, 0.13, 0, 0x9aa1b4)                       # wings
        b((0.07, 0.07, 0.065), 0.07, 0.145, 0, 0xf8f8fb)                     # head
        b((0.06, 0.06, 0.06), 0.12, 0.14, 0, 0xffc044)                       # bill
    if life:
        with animated(life, (x, y, z), yaw):
            build()
    else:
        build()

def boat(at, yaw, hull, trim=0xfff6eb, L=0.95):
    """A small open boat pulled up the sand, bow to +Z turned by `yaw`: a hull
    a car long, its gunwale and thwart, the bow drawn to a point."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def b(size, dx, dy, dz, color, turn=0.0):
        box(size, (x + dx * c + dz * s, y + dy, z - dx * s + dz * c), color, yaw=yaw + turn)
    b((0.36, 0.14, L * 0.8), 0, 0.07, -L * 0.08, hull)
    b((0.25, 0.14, 0.25), 0, 0.07, L * 0.32, hull, turn=math.pi / 4)        # the bow
    b((0.4, 0.05, L * 0.82), 0, 0.165, -L * 0.08, trim)
    b((0.3, 0.06, 0.08), 0, 0.17, 0.0, 0x9a7b55)                            # the thwart

def creel(at, yaw=0.0):
    """A crab pot a fifth of a car long: a plank base, its net drawn over."""
    x, y, z = at
    box((0.26, 0.06, 0.36), (x, y + 0.03, z), 0x9a7b55, yaw=yaw)
    box((0.22, 0.16, 0.32), (x, y + 0.14, z), 'sky', yaw=yaw)

def umbrella(at, r, h, colors, gores=8):
    """A beach umbrella: a pole and a canopy of gores in alternating colours,
    peaked over the pole and falling to its rim."""
    x, y, z = at
    beam((x, y, z), (x, y + h + 0.06, z), 0.06, 0xfff6eb)
    top = (x, y + h + 0.05, z)
    for i in range(gores):
        a0, a1 = i / gores * 2 * math.pi, (i + 1) / gores * 2 * math.pi
        rim0 = (x + math.cos(a0) * r, y + h - 0.1, z + math.sin(a0) * r)
        rim1 = (x + math.cos(a1) * r, y + h - 0.1, z + math.sin(a1) * r)
        poly([top, rim0, rim1], [(0, 1, 2)], colors[i % len(colors)])

def palm(at, h=2.4, lean=0.3, yaw=0.0, trunk=0x9a7b55, sink=0.0):
    """A palm in the kit's manner, as tall as the beach's own (1.8 to 3): a
    leaning trunk in three tapering lengths, a crown of drooping fronds, two
    coconuts. `sink` carries the trunk on that far under its foot, for a palm
    set rigidly on a slope (its downhill side shows trunk, not air)."""
    x, y, z = at
    k = h / 4.2
    dx, dz = math.cos(yaw), math.sin(yaw)
    pts = [(x + dx * lean * h * t * t, y + h * t, z + dz * lean * h * t * t) for t in (0, 0.36, 0.7, 1.0)]
    if sink:
        rod((x, y - sink, z), pts[0], 0.3 * k, trunk, segs=6)
    for i in range(3):
        rod(pts[i], pts[i + 1], (0.3 - 0.06 * i) * k, trunk, r2=(0.26 - 0.06 * i) * k, segs=6)
    tx, ty, tz = pts[-1]
    for i in range(6):                                  # each frond one blade, drooping
        a = yaw + i * math.pi / 3 + 0.3
        ca, sa = math.cos(a), math.sin(a)
        beam((tx, ty + 0.1 * k, tz), (tx + ca * 2.1 * k, ty - 0.45 * k, tz + sa * 2.1 * k), 0.5 * k, 0x61cb8b, d=0.06)
    for sd in (-1, 1):
        box((0.3 * k, 0.3 * k, 0.3 * k), (tx + sd * 0.25 * k * dz, ty - 0.2 * k, tz - sd * 0.25 * k * dx), 0x9a6a46)

class square:
    """Blocks built inside stay square: a small thing far out (a swimmer's
    head) would pay a chamfer's triangles for an edge no racer resolves."""
    def __enter__(self):
        self.before = set(bpy.context.scene.objects)
        return self
    def __exit__(self, *exc):
        for o in bpy.context.scene.objects:
            if o not in self.before:
                o['chamfer'] = 0

class moved:
    """What is built inside, its moving parts and their path markers too,
    built about the origin and shifted to (x, z): one scene's group laid out
    beside another in the same piece."""
    def __init__(self, x, z):
        self.x, self.z = x, z
    def __enter__(self):
        self.before = set(bpy.context.scene.objects)
        self.anims = len(ANIMS)
        return self
    def __exit__(self, *exc):
        shift = P(self.x, 0.0, self.z)
        for o in bpy.context.scene.objects:
            if o not in self.before and o.parent is None:
                o.location += shift
        for i in range(self.anims, len(ANIMS)):
            name, (px, py, pz), yaw, parent, tilt = ANIMS[i]
            ANIMS[i] = (name, (px + self.x, py, pz + self.z), yaw, parent, tilt)
        return False

SEA = 0.12   # the sea's surface over the sand a piece in it stands on (buildWater's WATER_LIFT)
SEA_SUNK = 0.8   # how far a `shore` with a `w` lets the sea down by the road (TtpRenderer.h kSeaSink)

def stadium(cx, cz, r, half, n):
    """A closed loop of (x, z) like a running track: two straights along Z
    `half` either side of cz, `r` either side of cx, joined by half circles
    of `n` steps, starting at the +X straight's far end."""
    pts = []
    for zc, a0 in ((cz + half, 0.0), (cz - half, math.pi)):
        pts += [(cx + r * math.cos(a0 + math.pi * i / n), zc + r * math.sin(a0 + math.pi * i / n)) for i in range(n)]
    return pts

def wave(at, L):
    """A breaking wave rolling in to -X from `at` (its foot on the sand, the
    sea's surface SEA over it): a ridge of water `L` long along Z, gentle at
    its back, its crest and steep face white with foam, dying away at both
    ends."""
    x0, y0, z0 = at
    back = [(-0.75, -0.08), (-0.35, 0.06), (-0.05, 0.19)]          # (x, y over SEA): the swell's back
    front = [(-0.05, 0.19), (0.08, 0.21), (0.16, 0.12), (0.26, -0.08)]   # the crest and the face, -X is in
    rows = [(-0.5, 0.1), (-0.2, 0.95), (0.2, 0.95), (0.5, 0.1)]
    for prof, color in ((back, 'sky'), (front, 0xfff6eb)):
        n = len(prof)
        verts = [(x0 - x, y0 + SEA - 0.08 + (y + 0.08) * h, z0 + f * L) for f, h in rows for x, y in prof]
        faces = [(j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i)
                 for j in range(len(rows) - 1) for i in range(n - 1)]
        poly(verts, faces, color)

def flames(tongues, heart, at=(0.0, 0.0, 0.0)):
    """A camp fire's flames: orange tongues round a yellow heart, each
    (dx, dz, r, h, lift, beat) a cone that flickers up and down on its own
    short beat (anim_bob, out of step with the others), so the tips dance
    while the fire as a whole stands still. Each foot is sunk `lift` under
    the embers at `at`, so a tongue at the top of its flicker shows no gap."""
    x0, y0, z0 = at
    for k, (dx, dz, r, h, lift, beat) in enumerate(tongues + (heart,)):
        with animated('anim_bob:h=%.3f:p=%.2f#flame%d' % (lift, beat, k), (x0 + dx, y0, z0 + dz)):
            cyl(r, h + lift, (x0 + dx, y0 + 0.03 - lift, z0 + dz),
                0xffc044 if k == len(tongues) else 0xff7e44, r2=0.01, segs=5)

def flag_on_pole(at, h, colors, wave, w=0.32, fh=0.2):
    """A slim pole `h` tall and a flag of horizontal bands flying to +X off its
    top, hinged there; `wave` names the cloth's flap (set_motion.h)."""
    x, y, z = at
    box((0.05, h, 0.05), (x, y + h / 2, z), 0xfff6eb)
    with animated(wave, (x, y + h, z)):
        n = len(colors)
        for i, c in enumerate(colors):
            box((w, fh / n, 0.03), (x + w / 2 + 0.02, y + h - fh * (i + 0.5) / n, z), c)

def on_a_rise():
    """For a piece tracks.js stands on a beach rise: a stone buried under its
    middle as a DRAPED part, which is what tells the renderer the piece
    levels nothing (it would cut its clearing down to the lowest land under
    its footprint, the rise's foot by the kerb, and stand in a hole). The
    piece then stands on the plain plus its `y`, the rise's height. Call it
    after join_still()."""
    def foot():
        with plain_parts():
            box((0.3, 0.3, 0.3), (0.0, -0.6, 0.0), 'slate')
    draped('foot', foot)

def gabled_house(cx, cz, w, d, h, rh, wall, roof, eave=0.16):
    """A house as one solid: walls `w` across (X) and `d` along (Z), `h` to
    the eaves, running on under the ground; a plain gabled roof over them,
    its ridge along Z `rh` over the eaves, two slabs that meet at the ridge
    and oversail the walls by `eave`; the gables filled in the wall's own
    colour up to the roof. Nothing of the wall stands through the roof."""
    box((w, h + 0.5, d), (cx, (h - 0.5) / 2, cz), wall)
    for sz in (-1, 1):
        poly([(cx - w / 2, h, cz + sz * d / 2), (cx + w / 2, h, cz + sz * d / 2), (cx, h + rh, cz + sz * d / 2)],
             [(0, 1, 2)], wall)
    a = math.atan2(rh, w / 2)
    run = (w / 2 + eave) / math.cos(a)
    for sx in (-1, 1):
        mx = cx + sx * (w / 2 + eave) / 2
        my = h + rh - 0.5 * (w / 2 + eave) * math.tan(a) + 0.05
        box((run, 0.1, d + 2 * eave), (mx, my, cz), roof, roll=sx * a)
    box((0.2, 0.1, d + 2 * eave + 0.04), (cx, h + rh + 0.06, cz), roof)

def crab_pot(at, yaw=0.0):
    """A crab pot as the fishers stack them: a half barrel of netting on a
    plank base, a hoop at each end, a third of a car long."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    box((0.34, 0.05, 0.5), (x, y + 0.025, z), 0x9a7b55, yaw=yaw)
    o = cyl(0.17, 0.46, (x - 0.23 * s, y + 0.1, z - 0.23 * c), 'sky', segs=10, axis='along', yaw=yaw, stem=True)
    o['ramp'] = 0.3
    for d in (-0.22, 0.0, 0.22):
        cyl(0.185, 0.035, (x + (d - 0.017) * s, y + 0.1, z + (d - 0.017) * c), 0xff7e44, segs=10, axis='along', yaw=yaw)

def gravel_yard(rects):
    """Gravel laid for vehicles on the sand: flat grey beds (the palette's
    pale lavender read as blue paving), each (x0,
    x1, z0, z1), a few fingers thick, overlapping at slightly different
    levels so no two tops fight; the last may be the track to the kerb."""
    with plain_parts():
        for k, (x0, x1, z0, z1) in enumerate(rects):
            o = box((x1 - x0, 0.06 + 0.012 * k, z1 - z0), ((x0 + x1) / 2, 0.02 + 0.006 * k, (z0 + z1) / 2), 'grey')
            rowed(o, 3 + 2 * (k % 2))

# ---- Tidepool ----
# ---- Tidepool ----

@piece(1.0)
def rock_pool():
    # Tidepool: the big pool the tide left in the reef, sunk in a low shelf
    # of the reef's slate that runs on along the beach toward the headland
    # (+Z): the water lies a step down inside the shelf's lip, a ring of
    # foam where it laps the rock, pale over the shallow ledges at its edge
    # and a deep saturated blue in the middle, its outline the rock's own
    # uneven curve. One polar mesh on shared rings and spokes, so nothing of
    # it fights the rest for the depth test, and draped, so it lies on the
    # sand as drawn (round 10: a blue disc in a crown of near-black slabs
    # read as a fountain). A gull stands on the lip watching the cars and
    # one soars over the beach toward the road.
    N, WY, LIP = 36, 0.06, 0.32
    def rim(a):                                                      # the water's uneven edge
        return 3.6 * (1.0 + 0.12 * math.sin(2 * a + 0.4) + 0.07 * math.sin(3 * a + 1.9) + 0.05 * math.sin(5 * a + 0.8))
    def shelf(a):                                                    # how far the rock reaches past the water
        along = max(0.0, math.sin(a)) ** 2                           # long toward the headland (+Z)
        sea = max(0.0, -math.cos(a)) ** 1.5                          # broad on the sea side (-X)
        return 1.6 + 5.5 * along + 1.8 * sea + 0.35 * math.sin(4 * a + 1.3)
    rows = []
    for i in range(N + 1):
        a = i / N * 2 * math.pi
        c, sn = math.cos(a), math.sin(a)
        r0, w = rim(a), shelf(a)
        top = LIP + 0.12 * max(0.0, -c) + 0.05 * math.sin(3 * a)
        prof = [(0.0, WY - 0.03), (0.35 * r0, WY - 0.03), (0.68 * r0, WY), (0.9 * r0, WY), (r0, WY + 0.01),   # the water
                (r0 + 0.12, WY + 0.02),                                                                        # the foam
                (r0 + 0.2, top), (r0 + 0.45 * w, top + 0.06), (r0 + 0.85 * w, top * 0.7), (r0 + w + 0.5, -0.06)]
        rows.append([(c * r, y, sn * r) for r, y in prof])
    kinds = ('deep', 'deep', 'mid', 'shallow', 'shallow', 'foam', 'lip', 'shelf', 'shelf')
    polys = {}
    for i in range(N):
        for j, kind in enumerate(kinds):
            polys.setdefault(kind, []).append([rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]])
    def pool():
        for kind, quads in polys.items():
            sw = {'deep': 'blue', 'mid': 'blue', 'shallow': 'sky', 'foam': 'white', 'lip': 'grey', 'shelf': 'lavender'}[kind]
            o = colored_faces([(sw, q) for q in quads], 'pool_' + kind)[0]
            for pl in o.data.polygons:
                if pl.normal.z < 0:
                    pl.flip()
            rowed(o, {'deep': 16, 'mid': 6, 'shallow': 24, 'foam': 2, 'lip': 26, 'shelf': 30}[kind])
        # knuckles of the reef standing up out of the shelf on its sea side
        # and along toward the headland, so the shelf reads as rock, not a rim
        for k, (a, d, sz, sq) in enumerate(((2.7, 1.9, 3.4, 0.62), (3.3, 2.6, 3.8, 0.66), (3.9, 1.7, 3.0, 0.6),
                                            (1.75, 4.9, 3.2, 0.6), (1.45, 3.4, 2.4, 0.55), (2.2, 2.6, 2.2, 0.5))):
            r = rim(a) + 0.3 + d
            stone(r * math.cos(a), r * math.sin(a), sz, 1.3 * k, 230.0 + k, squat=sq, rock=('grey', WET),
                  top='lavender', y=0.1)
        reef_tone()
    draped('pool', pool)
    gull((math.cos(0.4) * 4.3, LIP, math.sin(0.4) * 4.3), 0.0, 'anim_watch:r=24+hop:r=10:h=0.2#gull')
    ring = [(6.0 + 7.0 * math.cos(i * math.pi / 8), 3.6, 1.0 + 7.0 * math.sin(i * math.pi / 8)) for i in range(16)]
    for i, at in enumerate(ring):
        marker('path_soar_%d' % i, at)
    gx, gz = math.cos(1.25) * 6.5, math.sin(1.25) * 6.5
    with animated('anim_path:c=soar:p=22:f=1+bob:h=0.5:p=5.5#soar', (gx, 0.1, gz)):
        box((0.2, 0.07, 0.08), (gx, 0.1, gz), 0xf8f8fb)
        box((0.07, 0.06, 0.065), (gx + 0.12, 0.13, gz), 0xf8f8fb)
        box((0.06, 0.04, 0.05), (gx + 0.17, 0.12, gz), 0xffc044)
        for sd in (-1, 1):
            box((0.11, 0.03, 0.26), (gx + 0.01, 0.14, gz + sd * 0.16), 0x9aa1b4, pitch=sd * 0.2)
            box((0.08, 0.03, 0.08), (gx, 0.17, gz + sd * 0.32), 0x38383d, pitch=sd * 0.2)

@piece(1.0)
def crab_pots():
    # Tidepool: the crab fishers' landing above the reef, at a car's scale: a
    # blue net loft with its door to the road (+X) and floats hung on its
    # wall, the boat hauled up beside it with its pale sail hung up its mast to
    # dry (what a racer sees first, over the kerb; not the roof's red, which
    # it stands in front of from the road), creels stacked high by the slip, a
    # net drying on two poles, and the fisher in yellow oilskins sorting the
    # catch, who turns to watch the cars go by.
    gabled_house(-0.8, 0.0, 1.5, 1.7, 1.0, 0.6, 0x6794d9, 0xcf534f)
    box((0.06, 0.74, 0.5), (-0.03, 0.37, 0.0), 0xfff6eb)                       # the door, in its white frame
    box((0.06, 0.66, 0.4), (-0.01, 0.34, 0.0), 0x4f5260)
    box((0.06, 0.3, 0.36), (-0.03, 0.62, -0.55), 0x8ecae6)                     # a window
    for z in (-0.45, -0.1, 0.25):
        box((0.13, 0.13, 0.07), (-0.8 + z, 0.55, 0.84), 0xff7e44)            # floats on the wall
    # The dinghy sits up on its launching trolley, as a boat kept up the beach
    # does, so it is wheeled down to the water rather than lying on the sand
    # far from it: two wheels under its middle, the cradle's bearers along
    # its keel and the towing handle to the slip.
    bx, bz, T = 0.75, -1.75, 0.17
    c, s = math.cos(0.25), math.sin(0.25)
    def on_boat(dx, dz):
        return (bx + dx * c + dz * s, bz - dx * s + dz * c)
    for sd in (-1, 1):
        wx, wz = on_boat(sd * 0.21, -0.1)
        scenery_wheel(wx, 0.1, wz, 0.1, 0.06, 0.25)
        bx0, bz0 = on_boat(sd * 0.12, -0.5)
        bx1, bz1 = on_boat(sd * 0.12, 0.3)
        beam((bx0, T - 0.04, bz0), (bx1, T - 0.04, bz1), 0.05, 0x9a7b55)
    ax0, az0 = on_boat(-0.2, -0.1)
    ax1, az1 = on_boat(0.2, -0.1)
    beam((ax0, 0.085, az0), (ax1, 0.085, az1), 0.05, 'dark')                    # the axle
    hx0, hz0 = on_boat(0.0, 0.3)
    hx1, hz1 = on_boat(0.0, 0.85)
    beam((hx0, T - 0.04, hz0), (hx1, 0.06, hz1), 0.05, 0x9a7b55)
    boat((bx, T, bz), 0.25, 0xfff6eb, trim=0x339cf2)
    box((0.07, 1.35, 0.07), (bx, 0.75 + T, bz), 0x9a7b55)                     # the mast
    sail = [(bz - 0.75, 0.42 + T), (bz - 0.05, 1.38 + T), (bz - 0.05, 0.35 + T)]
    prism([(z, y) for z, y in sail], bx + 0.02, 0.03, 0xfff6eb)               # the sail, hung up to dry
    # the crab pots, stacked three, two and one on the sand before the hut
    for (x, y, z) in ((0.55, 0.0, 0.8), (0.55, 0.0, 1.36), (0.55, 0.0, 1.92), (0.55, 0.3, 1.08), (0.55, 0.3, 1.64),
                      (0.55, 0.6, 1.36)):
        crab_pot((x, y, z), 0.0)
    # a net hung over a line between two poles to dry: green, sagging with
    # the line and hanging deepest in the middle, not a board on two posts
    # (round 8: on tall drying poles, twice a person and more, the net hung
    # deep with its floats along the head rope: the landing's one tall thing,
    # which shows over the kerb where the hut and the creels do not)
    for z in (2.6, 4.4):
        box((0.09, 2.0, 0.09), (-0.2, 1.0, z), 0x9a7b55)
    line = sag((-0.2, 1.95, 2.63), (-0.2, 1.95, 4.37), 0.14, n=7)
    for i in range(6):
        (_, y0, z0), (_, y1, z1) = line[i], line[i + 1]
        drop = 0.95 + 0.25 * (1 - abs(i - 2.5) / 2.5)
        box((0.03, drop, z1 - z0 + 0.02), (-0.2, (y0 + y1) / 2 - drop / 2, (z0 + z1) / 2), 'green' if i % 2 else 'sky')
        beam(line[i], line[i + 1], 0.04, 0x9a7b55)
        box((0.1, 0.1, 0.1), (-0.2, (y0 + y1) / 2 - 0.02, (z0 + z1) / 2), 0xff7e44)
    with animated('anim_watch:r=22:d=70#fisher', (1.25, 0, 0.1)):
        figure((1.25, 0, 0.1), 0.0, shirt=0xffc044, legs=0x38383d, hair=0x38383d)
    join_still('landing')
    on_a_rise()

# Tidepool's rock, the reef's own slate laid in beds: dark slate and its
# paler grey in turn, a ledge where each hard bed stands out, and the turf
# of the downs over the top. Its tone is fixed per bed (tidepool_tone), not
# run down the ramp by height: a cliff's foot by the water came out near
# black and its brow as pale as the road.
TIDE_STRATA = ((-0.6, 0.7, 'grey', -0.85), (0.7, 1.6, 'lavender', 0.25), (1.6, 2.6, 'leaf', -0.85),
               (2.6, 4.0, 'leaf', -0.85), (4.0, 7.5, 'leaf', -0.85))

def tidepool_tone():
    """Every stratum of a Tidepool rock piece at one row of its swatch:
    the slate and its paler bed a little over half grey in the atlas, which
    the shade of a face turned from the sun brings down to the slate rule's
    35-45 per cent (the slate swatch itself came out near black), the turf
    the downs' own green."""
    for o in bpy.context.scene.objects:
        if o.type != 'MESH' or not o.name.startswith('stratum') or o.get('row') is not None:
            continue
        rowed(o, {'grey': 16, 'lavender': 31, 'leaf': 27}.get(o['swatch'], 12))

@piece(1.0)
def tidepool_cutting():
    with plain_parts():
        tidepool_cutting_build()

def tidepool_cutting_build():
    # Tidepool: the island's backbone, a spine of bedded slate under turf
    # that runs from the east downs across the lap's waist (where the road
    # goes through it in a cutting) and on west over the sand toward the
    # headland, sinking as it goes into the reef's ledges. Placed on the
    # road's centreline at the cutting (+Z along the road, +X its left):
    # the cutting's walls stand clear of the sand strip, sheer slate beds
    # the height of a cottage, the spine's back green. The spine runs off to
    # the right (-X) toward the west coast (SPINE: its bearing in this frame).
    SPINE = -1.38                                       # the yaw that runs a form's z along the spine
    d = (math.sin(SPINE), math.cos(SPINE))
    def on_spine(t, off=0.0):
        return (d[0] * t + d[1] * off, d[1] * t - d[0] * off)
    forms = []
    for t, off, h, rx, rz, ln, p in ((-13.0, 0.5, 6.8, 9.0, 7.0, 6.0, 0.8),     # the east shoulder, into the downs
                                     (-1.0, 0.0, 4.6, 8.5, 6.0, 6.0, 0.6),      # over the cutting
                                     (10.0, -0.8, 6.0, 8.5, 6.0, 4.0, 0.8),     # a knoll west of it
                                     (19.0, 0.6, 4.6, 8.0, 5.5, 6.0, 0.7),      # the saddle
                                     (28.0, -0.4, 5.4, 8.5, 6.0, 4.0, 0.8),     # a last knoll
                                     (37.0, 0.0, 2.6, 7.0, 5.0, 6.0, 0.9)):     # sinking toward the reef
        cx, cz = on_spine(t, off)
        forms.append((cx, cz, h, rx, rz, SPINE, p, ln))
    M = massif_height(tuple(forms), rough=0.7, seed=4.3, warp=0.8)
    strata_massif(M, -46.0, 24.0, -16.0, 24.0, TIDE_STRATA, corridor=(5.6, 4.0), step=2.4, tol=0.35,
                  summits=False)
    tidepool_tone()
    def scree():
        # slabs fallen from the cutting's walls, lying on the verge at their feet
        for i, (x, z, s) in enumerate(((6.3, -4.5, 0.7), (-6.4, -3.0, 0.8), (6.5, 3.8, 0.6), (-6.6, 4.4, 0.65))):
            stone(x, z, s * 1.6, 0.9 * i, 7.0 + i, squat=0.5, rock=('grey', WET), top='lavender', y=-0.05)
        reef_tone()
    draped('scree', scree)

# Tidepool's reef in three forms, each its own silhouette (round 10: nine
# near-alike heaps of boulders read as one row of grey stones): the seal
# shelf along the east bend, the headland with its sea arch at the head of
# the west bend, the stacks at its end. Each stands in the surf a stride off
# the kerb on the outside of a bend, where the chase camera swings to it,
# and is built along the road's own curve (BEND: the bend's centre is that
# far to the road's left of the placement, on the centreline).
REEF_BEDS = ((-0.6, 0.7, 'grey', 0.08), (0.7, 1.7, 'lavender', 0.18), (1.7, 2.7, 'grey', 0.08),
             (2.7, 3.7, 'lavender', 0.16), (3.7, 4.8, 'grey', 0.08), (4.8, 5.9, 'lavender', 0.14),
             (5.9, 7.0, 'grey', 0.08), (7.0, 7.6, 'leaf', -0.85))

def tidepool_on_bend(R, rho, th):
    """The piece-frame point `rho` from a left-hand bend's centre (R to the
    road's left), `th` radians along it from the placement."""
    return (R - rho * math.cos(th), rho * math.sin(th))

def tidepool_massif(M, x0, x1, z0, z1, bands, at=(0.0, 0.0), yaw=0.0, **kw):
    """strata_massif built about its own origin, then turned by `yaw` and
    set down at `at` (piece frame): an arch's corridor runs along the
    massif's own z, whichever way the arch stands. Returns the tunnel."""
    before = set(bpy.context.scene.objects)
    tunnel = strata_massif(M, x0, x1, z0, z1, bands, **kw)
    T = Matrix.Translation(P(at[0], 0.0, at[1])) @ Matrix.Rotation(yaw, 4, 'Z')
    for o in bpy.context.scene.objects:
        if o not in before and o.parent is None:
            o.matrix_world = T @ o.matrix_world
    return tunnel

def tidepool_reef_tone():
    """The reef's beds at fixed rows (tidepool_tone's reasoning), its arch's
    shadowed vault the same grey instead of the canyon's brown."""
    for o in bpy.context.scene.objects:
        if o.type != 'MESH' or not o.name.startswith('stratum') and not o.name.startswith('rock'):
            continue
        if o.get('swatch') == 'brown':
            o['swatch'] = 'grey'
            rowed(o, 30)
        elif o.get('row') is None and o.get('swatch'):
            rowed(o, {'grey': 16, 'lavender': 31, 'leaf': 27}.get(o['swatch'], 16))

def tidepool_surf(spots):
    """Surf breaking on the rock: a white crest of foam at each (x, z, len,
    yaw) that heaves up out of the sea and sinks back, each on its own beat,
    so the reef's foot is always somewhere breaking."""
    for k, (x, z, ln, yw) in enumerate(spots):
        with animated('anim_bob:h=0.32:p=%.1f:r=0.35#surf%d' % (3.1 + 0.55 * (k % 4), k), (x, 0.0, z)):
            c, s = math.cos(yw), math.sin(yw)
            for j in range(3):
                dz = (j - 1) * ln / 3
                h = 0.32 - 0.1 * abs(j - 1)
                box((0.7, h, ln / 3 + 0.1), (x + dz * s, SEA + h / 2 - 0.12, z + dz * c), 0xfff6eb,
                    yaw=yw + 0.12 * (j - 1))

@piece(1.0)
def reef_shelf():
    # Tidepool: the seals' shelf, the reef along the outside of the east
    # bend as one long bed of slate in steps, a car's height and a half at
    # its back and shelving into the surf, its top flat as bedded rock is,
    # broken by two gullies the sea runs into; the seals hauled out along
    # it, lifting their heads now and then, gulls wheeling over, the surf
    # breaking at its foot. Placed on the bend's centreline.
    R = 25.5
    def M(x, z):
        rho = math.hypot(x - R, z)
        th = math.atan2(z, R - x)
        across = rho - R - 13.5                                  # 0 on the shelf's spine
        if abs(th) > 0.78:
            return -1.0
        ends = smooth01((0.78 - abs(th)) / 0.18)
        gully = 1.0 - 1.4 * max(math.exp(-((th + 0.24) / 0.07) ** 2), math.exp(-((th - 0.3) / 0.065) ** 2))
        back = 2.7 + 0.6 * math.sin(3.1 * th + 0.6) + 0.4 * math.sin(7.3 * th) + 0.9 * noise2(x / 3.1, z / 3.1, 4.0)
        prof = max(0.0, 1.0 - max(0.0, abs(across) - 1.2) / 4.2) ** 0.6
        return (back * prof * gully + 0.3 * prof) * ends - 0.5
    strata_massif(M, -24.0, 10.0, -26.0, 26.0, REEF_BEDS[:4], grid=0.5, step=2.0, tol=0.3, summits=False)
    tidepool_reef_tone()
    for k, (th, ac, yw) in enumerate(((-0.6, -0.3, 0.4), (-0.42, 0.4, -0.2), (-0.08, 0.1, 0.6), (0.12, -0.5, 1.0),
                                      (0.5, 0.2, -0.4), (0.62, -0.2, 0.3))):
        x, z = tidepool_on_bend(R, R + 13.5 + ac, th)
        y = max(b[1] for b in REEF_BEDS[:4] if b[0] + 0.3 * (b[1] - b[0]) <= M(x, z) + 0.05)
        hauled_seal(x, y - 0.02, z, th + 0.5 * yw, 40 + k)       # facing the road
    ring = [(R - (R + 13) * math.cos(t), 6.0 + 0.6 * math.sin(3 * t), (R + 13) * math.sin(t))
            for t in (i / 12 * 1.2 - 0.6 for i in range(12))]
    ring += [(R - (R + 16) * math.cos(t), 7.0, (R + 16) * math.sin(t)) for t in (0.6 - i / 6 * 1.2 for i in range(1, 6))]
    for i, p in enumerate(ring):
        marker('path_gulls_%d' % i, p)
    for m in range(2):
        with animated('anim_path:c=gulls:p=18:f=1:o=%.2f#g%d' % (m * 0.5, m), (0.0, 0.0, 0.0)):
            box((0.16, 0.1, 0.32), (0.0, 0.0, 0.0), 0xf8f8fb)
            box((0.8, 0.04, 0.16), (0.0, 0.04, -0.02), 0x9aa1b4)
    surf = []
    for k, th in enumerate((-0.62, -0.38, -0.15, 0.08, 0.32, 0.56)):
        x, z = tidepool_on_bend(R, R + 19.2, th)
        surf.append((x, z, 3.2, th))
    tidepool_surf(surf)
    join_still('shelf')
    def sand():
        with plain_parts():
            box((0.3, 0.2, 0.3), (-8.0, -0.4, 0.0), 'grey')
    draped('foot', sand)

def tidepool_arch(at, yaw):
    """A sea arch: a fin of the reef's beds with the sea through it, the
    hole a car and a half wide and two high, turf on its back."""
    M = massif_height(((0.0, 0.0, 6.4, 2.6, 6.5, math.pi / 2, 0.3, 6.0),
                       (-3.4, 0.4, 5.2, 2.4, 3.0, 0.3, 0.35, 0.0),
                       (3.6, -0.3, 4.6, 2.2, 2.8, -0.2, 0.35, 0.0)), rough=0.7, seed=8.2, warp=0.6)
    return tidepool_massif(M, -10.0, 10.0, -5.0, 5.0, REEF_BEDS, at=at, yaw=yaw, corridor=(1.5, 2.6),
                           grid=0.4, step=1.8, tol=0.25)

@piece(1.0)
def tidepool_headland():
    # Tidepool: the headland at the head of the west bend, where the west
    # run points: a knoll of the reef's bedded slate with turf on its back,
    # its cliffs standing in the surf, and off its point a sea arch, the sea
    # breaking through it. Placed on the bend's centreline (+X its left).
    R = 27.0
    kx, kz = tidepool_on_bend(R, R + 17.5, -0.12)
    sx, sz = tidepool_on_bend(R, R + 22.0, 0.02)
    M = massif_height(((kx, kz, 7.8, 6.5, 5.5, 0.6, 0.35, 5.0),            # the knoll
                       (sx, sz, 4.6, 3.0, 4.0, -0.9, 0.4, 6.0)),           # its spur out to the arch
                      rough=1.5, seed=2.7, warp=1.4)
    strata_massif(M, -50.0, -2.0, -22.0, 18.0, REEF_BEDS, grid=0.5, step=2.2, tol=0.3, summits=False)
    ax, az = tidepool_on_bend(R, R + 27.0, 0.13)
    tidepool_arch((ax, az), -0.95)
    tidepool_reef_tone()
    tidepool_surf([(ax - 1.5, az - 2.4, 3.0, -0.5), (ax + 1.8, az + 1.6, 2.6, -0.95), (kx - 6.5, kz - 1.0, 3.4, 0.3),
                   (sx - 3.0, sz + 2.5, 3.0, 0.9)])
    ring = [(ax + 5.0 * math.cos(t), 8.5 + 0.5 * math.sin(2 * t), az + 4.0 * math.sin(t))
            for t in (i / 12 * 2 * math.pi for i in range(12))]
    for i, p in enumerate(ring):
        marker('path_gulls_%d' % i, p)
    for m in range(2):
        with animated('anim_path:c=gulls:p=15:f=1:o=%.2f#g%d' % (m * 0.5, m), (0.0, 0.0, 0.0)):
            box((0.16, 0.1, 0.32), (0.0, 0.0, 0.0), 0xf8f8fb)
            box((0.8, 0.04, 0.16), (0.0, 0.04, -0.02), 0x9aa1b4)
    join_still('headland')
    def sand():
        with plain_parts():
            box((0.3, 0.2, 0.3), (-8.0, -0.4, 0.0), 'grey')
    draped('foot', sand)

@piece(1.0)
def reef_stacks():
    # Tidepool: the stacks at the end of the west bend, a tower of the
    # reef's beds left standing in the surf when the headland it belonged to
    # fell, turf still on its top and gulls on it, and a stump beside it.
    R = 27.0
    ax, az = tidepool_on_bend(R, R + 16.0, 0.0)
    bx, bz = tidepool_on_bend(R, R + 19.5, 0.2)
    cx, cz = tidepool_on_bend(R, R + 13.5, -0.18)
    M = massif_height(((ax, az, 7.4, 2.9, 3.3, 0.4, 0.3, 1.0),
                       (bx, bz, 3.6, 2.2, 2.4, -0.3, 0.45, 0.0),
                       (cx, cz, 1.8, 2.6, 3.2, 0.9, 0.7, 2.0)), rough=0.5, seed=5.9, warp=0.5)
    strata_massif(M, -32.0, -6.0, -14.0, 16.0, REEF_BEDS, grid=0.4, step=1.8, tol=0.25, summits=False)
    tidepool_reef_tone()
    for k, (dx, dz, yw) in enumerate(((0.4, -0.5, 0.0), (-0.6, 0.3, 2.1))):
        gull((ax + dx, 7.0, az + dz), yw, 'anim_watch:r=24#gull%d' % k)
    tidepool_surf([(ax - 3.6, az - 1.0, 3.0, 0.2), (bx - 2.6, bz + 0.6, 2.4, -0.4), (cx - 3.2, cz - 1.5, 2.8, 0.6)])
    join_still('stacks')
    def sand():
        with plain_parts():
            box((0.3, 0.2, 0.3), (-8.0, -0.4, 0.0), 'grey')
    draped('foot', sand)

@piece(1.0)
def lifeboat_station():
    # Tidepool: the lifeboat station on the rocks outside the bend before
    # the line, at a building's real size beside a car: the boathouse,
    # white with a red roof and its name board, its great doors to the sea
    # (-X) at the head of the slipway, which runs down over the reef's
    # ledges into the surf; the lifeboat in its cradle at the top of the
    # slip, orange and navy, bow to the sea; the station's flag flying from
    # a tall staff by the road side, the coxswain's bell under a little roof.
    # Its back and gable stand over the kerb from the bend before it. On a
    # beach rise (tracks.js), so it stands at the road's height.
    white, red, navy, orange = 0xfff6eb, 0xcf534f, 0x38383d, 0xff7e44
    BX, BZ, W, D, H = -1.6, 0.0, 2.6, 4.2, 1.9
    gabled_house(BX, BZ, W, D, H, 1.25, white, red)
    box((0.08, 0.5, 2.6), (BX + W / 2 + 0.03, H - 0.45, BZ), 0x339cf2)                 # the name board to the road
    box((0.06, 0.32, 2.3), (BX + W / 2 + 0.07, H - 0.45, BZ), white)
    box((0.08, 1.6, 2.2), (BX - W / 2 - 0.03, 0.8, BZ), 0x339cf2)                       # the doors to the slip
    box((0.06, 1.5, 0.06), (BX - W / 2 - 0.07, 0.75, BZ), white)
    for dz in (-1.4, 1.4):
        box((0.08, 0.6, 0.5), (BX - W / 2 - 0.03, 1.3, BZ + dz), 'slate')            # its windows
    # the slipway: timber on the reef's rock, from the doors down to the sea
    SL0, SL1 = BX - W / 2, BX - W / 2 - 7.5
    with plain_parts():
        for k in range(12):
            t = k / 11
            x = SL0 + (SL1 - SL0) * t
            box((0.66, 0.12, 1.5), (x, 0.32 - 0.62 * t, BZ), 0x9a6a46 if k % 2 else 0x8a6a46, roll=0.08)
        for dz in (-0.55, 0.55):
            beam((SL0, 0.42, BZ + dz), (SL1, -0.28, BZ + dz), 0.12, 'grey')
        for k in range(5):
            x = SL0 + (SL1 - SL0) * (k + 0.5) / 5
            box((0.3, 0.9, 1.7), (x, -0.2 - 0.12 * k, BZ), 'grey')
    # the lifeboat in its cradle at the top of the slip, bow to the sea
    LX, LY = SL0 - 1.6, 0.62
    box((2.4, 0.5, 0.95), (LX, LY + 0.25, BZ), navy)
    box((0.7, 0.5, 0.7), (LX - 1.35, LY + 0.25, BZ), navy, yaw=math.pi / 4)
    box((2.5, 0.22, 1.02), (LX, LY + 0.58, BZ), orange)
    box((0.9, 0.5, 0.7), (LX + 0.35, LY + 0.92, BZ), white)
    box((0.95, 0.08, 0.75), (LX + 0.35, LY + 1.2, BZ), orange)
    box((0.06, 0.55, 0.06), (LX + 0.35, LY + 1.5, BZ), white)
    for dz in (-0.35, 0.35):
        box((1.8, 0.24, 0.12), (LX, LY - 0.08, BZ + dz), 0x8a6a46)
    # the flagstaff at the road side of the station, its flag flying along it
    flag_on_pole((0.2, 0.0, -2.8), 4.2, (red, white, red), 'anim_sway:a=x:d=20:p=1.9#flag', w=1.0, fh=0.6)
    # the bell under its little roof, by the doors
    for dz in (-0.3, 0.3):
        box((0.1, 1.2, 0.1), (BX + 1.9, 0.6, BZ + 2.9 + dz), 0x8a6a46)
    box((0.5, 0.1, 0.9), (BX + 1.9, 1.25, BZ + 2.9), red)
    cyl(0.16, 0.24, (BX + 1.9, 0.86, BZ + 2.9), 0xffc044, r2=0.1, segs=8)
    # the reef the station stands on, its ledges round the slip's foot
    for k, (x, z, sz, sq) in enumerate(((SL1 + 1.2, -2.3, 2.6, 0.5), (SL1 + 0.6, 2.4, 2.4, 0.55), (SL1 + 3.6, -2.0, 1.8, 0.5),
                                        (SL1 + 3.4, 2.2, 1.6, 0.45), (BX - 0.8, -3.4, 1.7, 0.5), (BX - 0.4, 3.6, 1.5, 0.45))):
        stone(x, z, sz, 0.9 * k, 260.0 + k, squat=sq, rock=('grey', WET), top='lavender', y=-0.15)
    reef_tone()
    tidepool_surf([(SL1 - 1.0, -0.4, 3.0, 0.0)])
    join_still('station')
    on_a_rise()

@piece(1.0)
def crab_boat():
    # Tidepool: the crab fishers' boat working the bay inside the headland,
    # at a boat's size beside a car: a blue hull with a white wheelhouse and
    # a tan lugsail, sailing a long loop out past the arch and in under the
    # stacks to the lifeboat slip and round again, rising and falling on the
    # swell, a wake at its stern. Placed on the west bend's centreline: the
    # loop lies in the sea off its outside (-X).
    R = 27.0
    loop = []
    for k in range(14):
        t = k / 14 * 2 * math.pi
        th = 0.26 * math.cos(t) - 0.02
        rho = R + 24.0 + 7.0 * math.sin(t)
        x, z = tidepool_on_bend(R, rho, th)
        loop.append((x, 0.0, z))
    for i, p in enumerate(loop):
        marker('path_crab_%d' % i, p)
    beach_sailing_boat('crab', 34.0, 0x339cf2, 0xf2bf99)

def beach_sailing_boat(chain, period, hull, sail):
    """A beach boat under sail riding the closed path `chain` (bow along
    its travel), at a boat's size beside a car: its hull, a white
    wheelhouse, a lugsail on its mast, a wake at its stern, rising and
    falling on the swell."""
    with animated('anim_path:c=%s:p=%.0f:f=1+bob:h=0.12:p=2.6#boat' % (chain, period), (0.0, 0.0, 0.0)):
        box((1.0, 0.45, 2.3), (0.0, SEA + 0.1, -0.1), hull)
        box((0.7, 0.45, 0.7), (0.0, SEA + 0.1, 1.15), hull, yaw=math.pi / 4)
        box((1.08, 0.12, 2.4), (0.0, SEA + 0.38, -0.1), 0xfff6eb)
        box((0.7, 0.6, 0.7), (0.0, SEA + 0.72, -0.6), 0xfff6eb)                   # the wheelhouse
        box((0.8, 0.1, 0.8), (0.0, SEA + 1.06, -0.6), 0xcf534f)
        box((0.12, 2.4, 0.12), (0.0, SEA + 1.5, 0.35), 0x8a6a46)                  # the mast
        prism([(0.4, SEA + 0.85), (0.5, SEA + 2.6), (-0.9, SEA + 2.2), (-0.7, SEA + 0.85)], 0.08, 0.06, sail)
        for k in range(3):                                                         # the wake
            box((0.5 + 0.3 * k, 0.04, 0.55), (0.0, SEA + 0.02, -1.45 - 0.45 * k), 0xfff6eb)

@piece(1.0)
def tidepool_cottages():
    # Tidepool: the crab fishers' row on the west downs' foot, where the
    # lap's waist bends away and the camera swings to them: four whitewashed
    # cottages at a house's size beside a car, stepped along the lane under
    # slate roofs, each door its own colour, a chimney smoking, a dry-stone
    # wall along their gardens at the road side and pots stacked by a gate.
    # +X is the road; the row runs along it (+Z).
    white, slate_roof = 0xfff6eb, 0x868ba1
    doors = (0x339cf2, 0xcf534f, 0x61cb8b, 0xffc044)
    for k, (z, w, d, h, rh) in enumerate(((-6.6, 2.2, 3.0, 1.35, 0.95), (-3.3, 2.0, 2.8, 1.25, 0.9),
                                          (0.4, 2.4, 3.4, 1.5, 1.0), (4.1, 2.0, 2.8, 1.3, 0.9))):
        cx = -1.4 - 0.3 * (k % 2)
        gabled_house(cx, z, w, d, h, rh, white, slate_roof)
        box((0.07, 0.8, 0.5), (cx + w / 2 + 0.03, 0.4, z - 0.4), white)              # the door in its frame
        box((0.07, 0.72, 0.4), (cx + w / 2 + 0.05, 0.36, z - 0.4), doors[k])
        box((0.07, 0.5, 0.6), (cx + w / 2 + 0.03, 0.85, z + 0.65), white)            # a window
        box((0.07, 0.4, 0.5), (cx + w / 2 + 0.05, 0.85, z + 0.65), 'slate')
        CH = h + rh * 0.7
        box((0.38, 0.9, 0.38), (cx, CH + 0.1, z + d / 2 - 0.3), 'grey')                # the chimney on the gable
        box((0.46, 0.1, 0.46), (cx, CH + 0.58, z + d / 2 - 0.3), 'slate')
        if k == 2:                                                               # one smokes (one chimney a track)
            marker('anim_smoke', (cx, CH + 0.75, z + d / 2 - 0.3))
    # the dry-stone wall along the gardens, a gate's gap before each door
    with plain_parts():
        for z0, z1 in ((-8.4, -7.3), (-6.5, -4.0), (-3.2, -0.3), (0.5, 3.6), (4.4, 6.0)):
            box((0.32, 0.5, z1 - z0), (1.3, 0.25, (z0 + z1) / 2), 'grey')
            box((0.36, 0.1, z1 - z0 + 0.04), (1.3, 0.53, (z0 + z1) / 2), 'lavender')
    for (z, y) in ((-7.6, 0.0), (-7.6, 0.3), (5.5, 0.0)):
        crab_pot((0.7, y, z), 0.0)
    join_still('row')

# ---- Cove ----

@piece(1.0)
def pirate_camp():
    # Cove: the crew's camp ashore, in a few big things at their real size
    # (round 10: a camp of 0.2 u props and pirates read as specks): a sail
    # cloth tent pitched with its dark open end to the cars coming (-Z), the
    # Jolly Roger on a tall pole over it, the treasure chest open on its
    # gold, a stack of barrels and crates, the cook fire under its pot on a
    # tripod, a cannon run out to the sea (-X) and the boat pulled up the
    # sand; two palms with a hammock slung between them. No one about.
    # Everything a car's height or more. +X is the road.
    canvas, stripe, wood = 0xfde4c7, 0xcf534f, 0x8a6a46
    # the tent: two slabs of sailcloth over a ridge along Z, a red band low
    # on each, the open gable dark inside, a pole at each end
    TX, TZ, W, L, H = -1.0, 0.2, 2.2, 2.8, 1.75
    a = math.atan2(H, W / 2)
    run = math.hypot(H, W / 2)
    for sx in (-1, 1):
        box((run, 0.08, L), (TX + sx * W / 4, H / 2, TZ), canvas, roll=sx * a)
        box((run * 0.3, 0.09, L + 0.02), (TX + sx * W * 0.4, H * 0.18, TZ), stripe, roll=sx * a)
    for sz in (-1, 1):
        beam((TX, 0.0, TZ + sz * (L / 2 + 0.05)), (TX, H + 0.25, TZ + sz * (L / 2 + 0.05)), 0.12, wood)
    beam((TX, H + 0.02, TZ - L / 2 - 0.1), (TX, H + 0.02, TZ + L / 2 + 0.1), 0.12, wood)
    poly([(TX - W * 0.42, 0.02, TZ + L / 2 - 0.05), (TX + W * 0.42, 0.02, TZ + L / 2 - 0.05),
          (TX, H * 0.85, TZ + L / 2 - 0.05)], [(0, 1, 2)], canvas)                        # its closed back
    poly([(TX - W * 0.36, 0.02, TZ - L / 2 + 0.3), (TX + W * 0.36, 0.02, TZ - L / 2 + 0.3),
          (TX, H * 0.72, TZ - L / 2 + 0.3)], [(0, 1, 2)], 0x38383d)                       # the dark inside
    # the flag over the camp, the kit's Jolly Roger on its tall pole, the
    # cloth flying across the piece so the cars see its face
    kit_flag('flag-pirate-high', (TX - 0.2, 0, TZ + L / 2 + 1.0), math.radians(90), 1.25, 'anim_sway:a=x:d=24:p=2.1')
    # the treasure chest open on its gold, before the tent
    kit('pirate', 'chest', (0.6, 0, TZ - 0.8), yaw=math.radians(100), scale=0.75)
    for k, (gx, gz) in enumerate(((1.1, TZ - 0.4), (1.2, TZ - 1.1), (0.95, TZ - 1.4), (1.3, TZ - 0.75))):
        box((0.3, 0.14, 0.3), (gx, 0.07, gz), 'yellow', yaw=0.6 * k)
    # the stores: barrels stood two and one on top, crates beside them
    for (x, y, z, yw) in ((-0.35, 0.0, TZ + 2.3, 0.3), (0.65, 0.0, TZ + 2.2, 1.1), (0.15, 0.84, TZ + 2.25, 0.7)):
        kit('pirate', 'barrel', (x, y, z), yaw=yw, scale=0.7)
    kit('pirate', 'crate', (0.55, 0, TZ + 3.7), yaw=0.25, scale=1.1)
    kit('pirate', 'crate', (-0.75, 0, TZ + 3.6), yaw=-0.2, scale=1.1)
    # the cook fire in its ring of stones, the pot on a tripod over it
    FX, FZ = 1.0, TZ - 3.0
    for k in range(7):
        a = k / 7 * 2 * math.pi
        box((0.32, 0.22, 0.26), (FX + math.cos(a) * 0.62, 0.11, FZ + math.sin(a) * 0.62), 'grey', yaw=-a)
    flames(((0.1, 0.0, 0.24, 0.55, 0.08, 0.33), (-0.14, 0.1, 0.2, 0.45, 0.07, 0.29), (-0.05, -0.15, 0.18, 0.4, 0.06, 0.27)),
           (0.02, -0.02, 0.15, 0.7, 0.09, 0.24), at=(FX, 0.0, FZ))
    for k in range(3):
        a = k / 3 * 2 * math.pi + 0.4
        beam((FX + math.cos(a) * 0.75, 0.0, FZ + math.sin(a) * 0.75), (FX, 1.45, FZ), 0.1, wood)
    beam((FX, 1.45, FZ), (FX, 1.0, FZ), 0.08, 0x38383d)
    cyl(0.32, 0.36, (FX, 0.72, FZ), 0x38383d, r2=0.26, segs=10, stem=True)              # the pot
    # the cannon on its carriage, run out to the sea
    kit('pirate', 'cannon-mobile', (-1.7, 0, TZ - 2.7), yaw=math.radians(-90), scale=0.65)
    # the boat pulled up the sand past the stores
    kit('pirate', 'boat-row-small', (-2.4, -0.05, TZ + 5.0), yaw=math.radians(170), scale=0.7)
    # the hammock between two palms behind the tent
    palm((-3.0, 0, TZ - 0.6), h=3.0, lean=0.2, yaw=math.radians(200))
    palm((-3.2, 0, TZ + 1.9), h=3.4, lean=0.25, yaw=math.radians(150))
    sl = sag((-3.0, 0.95, TZ - 0.4), (-3.18, 0.98, TZ + 1.7), 0.32, n=5)
    for i in range(4):
        beam(sl[i], sl[i + 1], 0.4, 0xfde4c7, d=0.08)
    join_still('camp')
    on_a_rise()

@piece(1.0)
def shipwreck_ribs():
    # Cove: an old wreck lying in the surf of the west bay's black sand,
    # half buried: a hull as long as the pirate ship, heeled over toward the
    # sea (-X), what is left of its planking buried in the sand on that
    # side, its ribs standing up out of the water in a row of thick dark
    # timbers on the side toward the road (+X), the stem post reared at the
    # bow and the snapped mainmast leaning out over it all. Wood the sea
    # has had for years, dark. The ribs a fist thick at a car's scale
    # (round 10: hairline ribs read as a comb).
    wood, wet = 0x6e5b3a, 0x4f4234
    L = 11.0
    # the keel and the buried bilge: planking along Z, falling to the sea
    box((0.5, 0.5, L), (0.0, -0.05, 0.0), wet)
    for y, x, z0, z1 in ((0.15, -0.9, -4.6, 4.2), (0.42, -1.6, -4.2, 3.6), (0.66, -2.15, -3.6, 2.8),
                         (0.88, -2.5, -2.8, 1.6)):
        box((0.9, 0.3, z1 - z0), (x, y, (z0 + z1) / 2), wood, roll=0.5)
    # the ribs: pairs of curved timbers, the road side's standing tall out
    # of the water, the sea side's broken low
    for k in range(9):
        z = -4.4 + k * 1.1
        w = 1.0 - abs(k - 4) * 0.07                                               # beamiest amidships
        hh = 1.0 if k % 3 != 1 else 0.7                                           # some snapped short
        tube([(0.0, 0.0, z), (1.0 * w, 0.2, z), (1.7 * w, 1.0, z), (1.95 * w, 1.0 + 2.2 * hh, z)],
             0.17, wood, res=3, smooth=True)
        tube([(0.0, 0.0, z), (-1.0 * w, 0.4, z), (-1.5 * w, 0.9 + 0.5 * (k % 2), z)], 0.15, wood, res=3, smooth=True)
    # the road side's planking still on the ribs' feet, broken off higher
    # up and toward the ends, so the hull shows as a hull and not a comb
    for y, x, z0, z1 in ((0.35, 1.25, -4.3, 4.0), (0.7, 1.6, -3.9, 3.3), (1.05, 1.78, -3.2, 2.2),
                         (1.4, 1.86, -2.4, 0.6), (1.75, 1.9, -1.6, -0.4)):
        box((0.2, 0.32, z1 - z0), (x, y, (z0 + z1) / 2), wood if y < 1.2 else 0x7d6a4a, roll=-0.35)
    beam((1.9, 2.25, -3.6), (1.9, 2.25, 3.4), 0.24, wood)
    # the stem post reared at the bow, the stern post low
    beam((0.0, -0.2, L / 2 - 0.3), (0.3, 4.0, L / 2 + 0.9), 0.36, wood)
    beam((0.0, -0.2, -L / 2 + 0.3), (0.1, 1.6, -L / 2 - 0.3), 0.3, wood)
    # the mainmast snapped and leaning out over the wreck, its yard askew
    rod((0.2, 0.0, 0.8), (1.6, 5.8, 1.3), 0.28, wood, r2=0.2, segs=7)
    beam((-0.9, 4.4, 0.4), (3.0, 5.2, 1.7), 0.2, wood)
    gull((1.6, 5.8, 1.3), 0.8, 'anim_watch:r=24#gull')                      # on the stump, watching the cars
    join_still('wreck')

# The longboat's route in the wharf's frame: from the finger pier's head out
# across the bay to the ship's side and back (tracks.js stands the wharf so
# the ship rides some 24 u on along +Z).
COVE_ROW = ((-7.6, 4.6), (-8.4, 9.0), (-7.6, 14.5), (-5.4, 18.6), (-3.4, 17.2), (-4.8, 12.0), (-5.6, 7.0))

@piece(1.0)
def jetty():
    # Cove: the pirates' wharf on the bay where the ship rides at anchor,
    # at its real size: a timber quay on stout piles along the water's
    # edge (Z, beside the road), its deck well over the kerb so it shows
    # from the seat (a landing stage at the sand's height lay hidden behind
    # the deck), a finger pier out from its far end to where the longboat
    # comes in, the crew's store shed on the quay's near end, the cargo
    # crane at the finger's root, barrels and crates stacked a car high. The
    # longboat sails out to the ship and back under its red sail. +X is the
    # road.
    wood, plank, pile = 0x8a6a46, 0xb06041, 0x6e5b3a
    D = 1.5                                                                     # the deck over the plain
    Z0, Z1, QW = -7.0, 7.0, 1.8                                                 # the quay's run and width
    n = int((Z1 - Z0) / 0.5)
    for k in range(n):                                                          # the quay's decking, across
        box((QW, 0.14, 0.46), (-QW / 2, D, Z0 + 0.25 + k * 0.5), plank if k % 3 else 0x9a6a46)
    for k in range(8):                                                          # its piles, both edges
        z = Z0 + 0.2 + k * (Z1 - Z0 - 0.4) / 7
        for x in (-QW + 0.1, -0.1):
            box((0.28, D + 0.9, 0.28), (x, (D - 0.9) / 2, z), pile)
    for x in (-QW + 0.1, -0.1):                                                 # the stringers
        box((0.2, 0.2, Z1 - Z0), (x, D - 0.15, 0.0), wood)
    # the finger pier out to sea at the quay's far end
    FZ, FL = 4.6, 5.0
    for k in range(int(FL / 0.5)):
        box((0.46, 0.14, 1.3), (-QW - 0.25 - k * 0.5, D, FZ), plank if k % 3 else 0x9a6a46)
    for k in range(3):
        for dz in (-0.55, 0.55):
            box((0.26, D + 0.9, 0.26), (-QW - 1.2 - k * 1.8, (D - 0.9) / 2, FZ + dz), pile)
    for dz in (-0.6, 0.6):                                                      # its rail, posts and bar
        for k in range(4):
            box((0.14, 0.75, 0.14), (-QW - 0.4 - k * 1.5, D + 0.4, FZ + dz), wood)
        box((FL, 0.14, 0.14), (-QW - FL / 2, D + 0.75, FZ + dz), wood)
    # the store shed on the quay's near end: plank walls, a red roof pitched
    # along the quay, its dark door to the road
    SZ, SW, SD, SH = Z0 + 1.6, 1.6, 2.6, 1.4
    box((SW, SH, SD), (-QW / 2, D + SH / 2, SZ), 0x9a7b55)
    for sx in (-1, 1):
        box((SW / 2 + 0.35, 0.12, SD + 0.3), (-QW / 2 + sx * SW / 4, D + SH + 0.28, SZ), 0xcf534f, roll=-sx * 0.6)
    for sz in (-1, 1):
        poly([(-QW / 2 - SW / 2, D + SH, SZ + sz * SD / 2), (-QW / 2 + SW / 2, D + SH, SZ + sz * SD / 2),
              (-QW / 2, D + SH + 0.55, SZ + sz * SD / 2)], [(0, 1, 2)], 0x9a7b55)
    box((0.08, 1.0, 0.8), (-QW / 2 + SW / 2 + 0.02, D + 0.5, SZ), 0x38383d)
    # the cargo crane at the finger's root: a stout post, its jib out over
    # the water, a crate slung from it
    CX, CZ = -QW + 0.3, FZ - 1.2
    box((0.32, 3.4, 0.32), (CX, D + 1.7, CZ), wood)
    beam((CX, D + 3.2, CZ), (CX - 3.0, D + 2.9, CZ + 0.6), 0.24, wood)
    beam((CX, D + 1.9, CZ), (CX - 1.6, D + 3.0, CZ + 0.3), 0.18, wood)
    box((0.1, 1.3, 0.1), (CX - 2.8, D + 2.25, CZ + 0.55), 0xfde4c7)
    kit('pirate', 'crate', (CX - 2.8, D + 1.42, CZ + 0.55), yaw=0.3, scale=0.7)
    # the cargo waiting on the quay, a car high
    for (x, z, yw) in ((-0.55, -2.2, 0.3), (-1.3, -1.5, 1.0), (-0.6, -0.8, 0.6)):
        kit('pirate', 'barrel', (x, D + 0.07, z), yaw=yw, scale=0.62)
    kit('pirate', 'barrel', (-0.8, D + 0.8, -1.5), yaw=0.2, scale=0.62)
    kit('pirate', 'crate', (-0.9, D + 0.07, 1.2), yaw=0.2, scale=1.0)
    kit('pirate', 'crate', (-0.85, D + 0.84, 1.3), yaw=0.7, scale=0.8)
    kit_flag('flag-pirate-high', (-QW - FL + 0.2, D, FZ + 0.6), math.radians(90), 0.6, 'anim_sway:a=x:d=24:p=2.3')
    join_still('wharf')
    # the longboat under its red lugsail, its bow to its local +X (the way
    # its path faces it), sailing the loop out to the ship and back and
    # bobbing on the swell
    for i, (x, z) in enumerate(COVE_ROW):
        marker('path_row_%d' % i, (x, SEA, z))
    bx, bz = COVE_ROW[0]
    with animated('anim_path:c=row:p=30:f=1+bob:h=0.08:p=2.4#boat', (bx, SEA, bz)):
        y0 = SEA - 0.15
        box((1.9, 0.42, 0.85), (bx - 0.15, y0 + 0.21, bz), 0x6e5b3a)                    # the hull
        box((0.62, 0.42, 0.62), (bx + 0.8, y0 + 0.21, bz), 0x6e5b3a, yaw=math.pi / 4)    # the bow
        box((2.0, 0.08, 0.92), (bx - 0.15, y0 + 0.44, bz), 0xfde4c7)                    # the gunwale
        box((0.16, 2.3, 0.16), (bx + 0.25, y0 + 1.5, bz), wood)                         # the mast
        c, s = math.cos(0.5), math.sin(0.5)
        sail = [(-0.9, 0.75), (0.75, 0.85), (0.55, 2.5), (-0.55, 2.3)]
        poly([(bx + 0.25 + u * c, y0 + v, bz + u * s) for u, v in sail], [(0, 1, 2, 3)], 0xcf534f)

# ---- Driftwood ----

class bleached:
    """Wood built inside is driftwood the sea and the sun bleached: warm,
    never grey (the palette's silver is lavender, and a beach of it read
    grey from the seat). Its body is the tan swatch down most of its ramp,
    honey in the sun at a limb's end and ochre at the wet foot (further down
    it turned terracotta); pale limbs are cream, and anything else keeps the
    light end of its ramp."""
    def __enter__(self):
        self.before = set(bpy.context.scene.objects)
        return self
    def __exit__(self, *exc):
        for o in bpy.context.scene.objects:
            if o not in self.before and o.get('swatch'):
                o['ramp'] = {'tan': 0.9, 'cream': 0.7}.get(o['swatch'], 0.35)
        return False

@piece(1.0)
def bonfire():
    # Driftwood: the beach fire at the end of the strand line, at a car's
    # scale: driftwood stood up in a cone in its ring of stones, the flames
    # flickering up out of it, its smoke going up over the beach; two logs
    # drawn up as seats round it, and a lean-to of driftwood poles behind
    # them out of the wind. No one about (round 10: three people half a car
    # long read as specks): a fire the size a beach party builds, its
    # flames as tall as a car, is what a racer sees of it.
    for k in range(9):
        a = k / 9 * 2 * math.pi
        box((0.22, 0.18, 0.2), (math.cos(a) * 0.62, 0.09, math.sin(a) * 0.62), 0x868ba1, yaw=-a)
    disc(0.55, (0, 0.0, 0), 0x38383d, segs=10, h=0.03)
    flames(((0.1, 0.0, 0.26, 0.7, 0.1, 0.31), (-0.14, 0.12, 0.2, 0.56, 0.09, 0.37),
            (-0.06, -0.16, 0.18, 0.48, 0.08, 0.27)), (0.02, 0.02, 0.14, 0.9, 0.12, 0.23))
    for k in range(7):
        a = k / 7 * 2 * math.pi + 0.3
        rod((math.cos(a) * 0.5, 0.02, math.sin(a) * 0.5), (math.cos(a) * 0.06, 0.85, math.sin(a) * 0.06),
            0.08, 0x8a6a46, segs=5)
    with bleached():
        for z in (-1.05, 1.05):                          # bleached driftwood, like the strand line's
            rod((-0.7, 0.16, z), (0.75, 0.16, z * 1.05), 0.17, 'tan', segs=7)
    # the lean-to: driftwood poles against a ridge pole, out of the wind,
    # about twice a standing person (THE SCALE RULE: a person is half a
    # unit), the tall end of a real one and half as much again (round 8: the
    # road stands most of a unit over this beach behind its kerb, and the
    # camp lay under it), and long, a shelter for the whole party
    R, B, H = 1.35, 1.1, 1.7                             # the ridge's height, how far back the poles reach, half its length
    with bleached():
        for z in (-H + 0.1, H - 0.1):                    # the uprights and ridge grey: white, they framed a goal
            rod((-1.25, 0, z), (-1.25, R, z), 0.06, 'tan', segs=5)
        rod((-1.25, R, -H), (-1.25, R, H), 0.06, 'tan', segs=5)
        for i in range(11):
            z = -H + 0.1 + i * (2 * H - 0.2) / 10
            rod((-1.25, R, z), (-1.25 - B, 0.0, z + 0.05 * (i % 2)), 0.06, 'tan' if i % 2 else 'cream', segs=5)
    # an old sail over the poles: without it the frame reads as a swing
    box((math.hypot(R, B) - 0.05, 0.03, 2 * H), (-1.25 - B / 2 - 0.03, R / 2 + 0.03, 0.0), 'cream',
        roll=math.atan2(R, B))
    # past the lean-to's end, a driftwood teepee the beachcombers stood up,
    # as they do on a beach the storms fill with wood: poles leant together
    # round a ring, crossing at the top, a person's height and a half
    tx, tz, TH = -1.0, H + 1.0, 1.4
    with bleached():
        for i in range(8):
            a = i / 8 * 2 * math.pi + 0.2
            rod((tx + math.cos(a) * 0.5, 0.0, tz + math.sin(a) * 0.5),
                (tx - math.cos(a) * 0.06, TH + 0.08 * (i % 3), tz - math.sin(a) * 0.06), 0.05,
                'tan' if i % 2 else 'cream', r2=0.03, segs=5)
    # two of the strand's dead trees over the camp, which is what a racer
    # sees of it from up the road
    with bleached():
        drift_snag(-2.6, -2.4, 3.2, 0.2, 2.6, 11.0)
        drift_snag(-1.9, 4.6, 2.4, 0.3, 0.9, 12.0, limbs=3)
    # the party's own colour: a striped windbreak across the camp's open end
    for i in range(6):
        box((0.4, 0.75, 0.04), (-0.95 + 0.4 * i, 0.5, -2.0), (0xff5040, 0xfff6eb)[i % 2])
    for i in range(4):
        box((0.06, 1.0, 0.06), (-1.15 + 0.8 * i, 0.5, -2.0), 0x9a6a46)
    marker('anim_smoke', (0.0, 0.9, 0.0))
    join_still('fire')
    on_a_rise()

# ---- Riptide ----

@piece(1.0)
def lifeguard_tower():
    # Riptide: the surf patrol's tower on the beach where the cars land off
    # the hop, on its own patch of sand at the road's height (a beach rise,
    # tracks.js), so a racer coming over the crest looks straight at it.
    # One chunky thing at a lifeguard tower's real size and a half: a white
    # hut on four stout stilts a car's height and more up, its lookout window
    # to the sea (+X), a red roof, a big red cross on a white board to the
    # road, the ramp down its back to the road side, and the patrol's flag
    # high over it on a mast of its own. Round its foot, big enough to read
    # from the seat: three beach umbrellas, the red rescue boat, a rack of
    # boards and the red-and-yellow flags. No people: a person at a car's
    # size is a speck (and a still one reads uncanny).
    white, red, yellow, wood, blue = 0xfff6eb, 0xff5040, 0xffc044, 0x9a7b55, 0x339cf2
    S, top = 1.4, 1.35                         # the stilts' spread, the deck's height
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((0.2, top + 0.4, 0.2), (sx * S / 2, (top - 0.4) / 2, sz * S / 2), white)
    for sz in (-1, 1):                         # cross braces under the deck, front and back
        beam((-S / 2, 0.2, sz * S / 2), (S / 2, top - 0.15, sz * S / 2), 0.12, white)
        beam((S / 2, 0.2, sz * S / 2), (-S / 2, top - 0.15, sz * S / 2), 0.12, white)
    box((S + 0.7, 0.14, S + 0.5), (0.15, top + 0.07, 0), wood)                  # the deck, its lookout end proud
    W, D, H, hx = 1.2, 1.3, 1.0, -0.1
    y0 = top + 0.14
    box((W, H, D), (hx, y0 + H / 2, 0), white)
    box((W + 0.04, 0.16, D + 0.04), (hx, y0 + 0.14, 0), red)                    # the red band
    box((0.08, 0.38, D * 0.74), (hx + W / 2 + 0.02, y0 + H * 0.62, 0), 0x8ecae6)  # the lookout window
    for sz in (-1, 1):
        box((W * 0.56, 0.32, 0.08), (hx + 0.12, y0 + H * 0.62, sz * (D / 2 + 0.02)), 0x8ecae6)
    for sz in (-1, 1):                         # the roof, peaked along the hut, deep eaves
        box((W + 0.5, 0.12, 0.5 * (D + 0.5) / math.cos(0.5)), (hx, y0 + H + 0.2, sz * (D + 0.5) / 4), red,
            pitch=-sz * 0.5)
    box((W + 0.56, 0.14, 0.18), (hx, y0 + H + 0.33 + 0.12, 0), white)            # its ridge
    # the cross on a white board to the road (-X), the size of a car's side
    box((0.08, 0.9, 0.9), (hx - W / 2 - 0.05, y0 + H * 0.52, 0), white)
    box((0.08, 0.64, 0.2), (hx - W / 2 - 0.1, y0 + H * 0.52, 0), red)
    box((0.08, 0.2, 0.64), (hx - W / 2 - 0.1, y0 + H * 0.52, 0), red)
    # the rail round the lookout end
    ex = 0.15 + (S + 0.7) / 2 - 0.06
    for sz in (-1, 0, 1):
        box((0.1, 0.42, 0.1), (ex, top + 0.35, sz * ((S + 0.5) / 2 - 0.06)), white)
    box((0.1, 0.1, S + 0.5), (ex, top + 0.56, 0), white)
    cyl(0.2, 0.1, (ex + 0.05, top + 0.36, 0.35), 0xff7e44, segs=8, axis='across')  # the ring buoy
    # the ramp down its back to the sand, toward the road
    fx, bx = -2.6, -(S + 0.7) / 2 + 0.15
    for sz in (-1, 1):
        beam((fx, 0.04, sz * 0.32), (bx, top, sz * 0.32), 0.12, wood)
    for i in range(7):
        t = (i + 0.5) / 7
        box((0.24, 0.07, 0.72), (fx + (bx - fx) * t, 0.07 + (top - 0.04) * t, 0), wood,
            roll=math.atan2(top, bx - fx))
    # the patrol's flag on its own mast off the deck's corner, high over the
    # roof: what shows first over the crest
    mx, mz = ex - 0.1, -(S + 0.5) / 2 + 0.12
    box((0.13, 4.3 - top, 0.13), (mx, top + (4.3 - top) / 2, mz), white)
    box((0.22, 0.22, 0.22), (mx, 4.36, mz), red)
    with animated('anim_sway:a=x:d=22:p=1.9#patrol', (mx, 4.2, mz)):
        box((0.06, 0.5, 0.42), (mx, 3.95, mz - 0.27), red)
        box((0.06, 0.5, 0.42), (mx, 3.95, mz - 0.69), yellow, yaw=0.12)
    # three big beach umbrellas on the road side of it, either way along
    for (x, z, c) in ((-1.4, -2.9, (red, white)), (-0.9, 2.8, (blue, white)), (0.4, 4.6, (yellow, red))):
        umbrella((x, 0, z), 1.0, 1.45, c, gores=8)
        box((0.8, 0.06, 0.46), (x + 0.5, 0.03, z + 0.4), c[0], yaw=0.3)           # a towel under it
    # the rescue boat pulled up toward the water, and its trolley
    with plain_parts():
        box((0.62, 0.28, 1.5), (2.3, 0.14, -1.1), red, yaw=0.2)
        box((0.44, 0.28, 0.44), (2.3 + 0.75 * math.sin(0.2), 0.14, -1.1 + 0.75 * math.cos(0.2)), red,
            yaw=0.2 + math.pi / 4)
        box((0.66, 0.08, 1.54), (2.3, 0.31, -1.1), white, yaw=0.2)
    # the board rack against the back stilts, three boards on it
    for z in (1.15, 2.1):
        box((0.12, 0.6, 0.12), (-0.9, 0.3, z), wood)
    box((0.12, 0.12, 1.1), (-0.9, 0.56, 1.62), wood)
    half = [(0.0, 0.0), (0.07, 0.02), (0.1, 0.14), (0.11, 0.4), (0.1, 0.66), (0.07, 0.86), (0.0, 0.96)]
    outline = [(z, y) for z, y in half] + [(-z, y) for z, y in reversed(half[1:-1])]
    for k, (c, st) in enumerate(((red, white), (blue, yellow), (yellow, red))):
        zc = 1.3 + k * 0.32
        board = prism([(zc + z, y) for z, y in outline], -0.8, 0.06, c)
        board.rotation_euler.y = -0.2
    # the swimming flags either side of the patrol's water, toward the sea
    for k, z in enumerate((-3.4, 3.2)):
        box((0.1, 1.9, 0.1), (3.2, 0.95, z), white)
        with animated('anim_sway:a=x:d=22:p=%.1f#swim%d' % (2.0 + 0.3 * k, k), (3.2, 1.85, z)):
            box((0.05, 0.28, 0.6), (3.2, 1.72, z - 0.33), red)
            box((0.05, 0.28, 0.6), (3.2, 1.44, z - 0.33), yellow)
    join_still('tower')
    on_a_rise()

# ---- Riptide's promenade ----

def beach_hut(x, y, z, yaw, body, trim=0xfff6eb):
    """A bathing hut a little chunkier than life (about 5 m to the ridge), its
    gable and door to the front (+X turned by `yaw`): a box in one colour, a
    white door, a pitched roof in its own colour with white bargeboards on
    both gables (a row seen from behind closes up into one striped box
    unless each back shows its pitch), standing on the boardwalk at `y`."""
    w, h, d, peak = 0.8, 0.86, 0.8, 0.34
    c, sn = math.cos(yaw), math.sin(yaw)
    def T(lx, ly, lz):
        return (x + lx * c + lz * sn, ly, z - lx * sn + lz * c)
    box((w, h, d), (x, y + h / 2, z), body, yaw=yaw)
    box((0.05, h * 0.74, d * 0.42), T(w / 2 + 0.015, y + h * 0.37, 0.0), trim, yaw=yaw)       # the door
    e, o = w / 2 + 0.06, d / 2 + 0.07
    verts = [T(e, y + h, -o), T(e, y + h, o), T(e, y + h + peak, 0.0),
             T(-e, y + h, -o), T(-e, y + h, o), T(-e, y + h + peak, 0.0)]
    poly(verts, [(0, 1, 2), (3, 5, 4), (0, 2, 5, 3), (1, 4, 5, 2), (0, 3, 4, 1)], body)        # the roof
    for end in (-1, 1):                                                                          # its bargeboards
        for side in (-1, 1):
            beam(T(end * (e + 0.02), y + h, side * o), T(end * (e + 0.02), y + h + peak, 0.0), 0.05, 0xfff6eb)

def angler(x, y, z, yaw, shirt, rod_to):
    """A fisher sitting on the pier's edge, legs over it, rod out to sea."""
    figure((x, y, z), yaw, shirt=shirt, legs=0x4f5260, hair=0x7a5a3a, pose='sit')
    beam((x - 0.02 * math.cos(yaw), y + 0.22, z + 0.02 * math.sin(yaw)), rod_to, 0.04, 0x38383d)

@piece(1.0)
def promenade():
    # Riptide's town end of the beach, where the causeway sets out: a timber
    # boardwalk at the road's own level along the straight's outer kerb (+X
    # is the road; its edge keeps the set pieces' 1.2 u off the deck), one
    # even row of bathing huts on it, their doors to the road, the kiosk at
    # the row's end, and the sea pier running on from
    # there out over the water (the track's `shore` brings the sea in under
    # it) to its pavilion: white, a red hipped roof, a lantern and a flag,
    # corner turrets to the land, a landing stage across its seaward side and
    # the excursion boat moored alongside. A seaside pier, not a fairground:
    # a big wheel read as a funfair on a surf beach. At yaw 180 +Z runs
    # against the cars, so the huts come first and the pier last, and the
    # straight points at the pavilion. The piece stands on the plain and
    # levels nothing (the umbrella on the sand drapes): the decks and piles
    # are built from well under it, so they reach the sand wherever it lies.
    wood, dark, white, red, deck_y = 0x9a7b55, 0x8a6a46, 0xfff6eb, 0xff5040, 0.38
    BW0, BW1, Z0, Z1 = -0.2, 2.2, -4.6, 9.0          # the boardwalk, 2.4 u wide
    FOOT = -1.2
    box((BW1 - BW0, 0.1, Z1 - Z0), ((BW0 + BW1) / 2, deck_y - 0.05, (Z0 + Z1) / 2), wood)
    with square():                                    # its piles along the sea side
        for k in range(3):
            z = Z0 + 0.3 + k * (Z1 - Z0 - 0.6) / 2
            box((0.14, deck_y - FOOT, 0.14), (BW0 + 0.12, (deck_y + FOOT) / 2, z), dark)
    # the huts: one even row, each in one colour, doors and gables to the
    # road. The S-bend before the straight sees the row from behind and the
    # straight from the road side, each looking along it, so each hut shows
    # only the end of it its neighbour leaves uncovered: from the bend its
    # back gable, from the straight its front (turned toward the straight,
    # the bend saw only their sides, closed up into one striped box)
    for k, c in enumerate((red, 0x339cf2, 0x22c46e, 0xffc044, white, red, 0x339cf2, 0x22c46e)):
        beach_hut(0.7, deck_y, 8.6 - 1.25 * k, 0.0, c, trim=0x339cf2 if c == white else white)
    # the kiosk at the row's end by the pier's root: a counter to the cars
    # under a red and white awning, an ice cream on its roof, a queue of two
    KX, KZ = 0.5, -1.9
    box((0.8, 0.66, 1.3), (KX, deck_y + 0.33, KZ), white)
    box((0.9, 0.07, 1.4), (KX, deck_y + 0.69, KZ), 0x339cf2)                           # the roof
    for i in range(3):
        box((0.46, 0.05, 1.4 / 3), (KX + 0.62, deck_y + 0.62, KZ - 0.47 + i * 0.467),
            red if i % 2 == 0 else white, roll=0.35)
    cyl(0.12, 0.28, (KX, deck_y + 0.72, KZ), 0xf2bf99, r2=0.02, segs=6)               # the cone, point down
    o = bpy.context.active_object
    o.location = P(KX, deck_y + 1.0, KZ)
    o.rotation_euler = (math.pi, 0, 0)
    box((0.24, 0.2, 0.24), (KX, deck_y + 1.08, KZ), 0xfde4c7)                          # the scoop
    with square():
        figure((1.5, deck_y, KZ - 0.2), math.pi, shirt=0x339cf2, legs=0x4f5260, hair=0x38383d)
        figure((1.8, deck_y, KZ + 0.25), math.pi, shirt=0xff7e44, legs=0x339cf2, hair=0xffc044)
    flag_on_pole((KX - 0.3, deck_y + 0.73, KZ + 0.5), 0.5, (red, white), 'anim_sway:a=z:d=20:p=2.0#kiosk')
    # the pier: on from the boardwalk's end a step down (its root lies
    # under the boardwalk's end, and two decks at one level fight), out over
    # the sea, turned a little off the road's line toward the water; railed
    # in white, a lamp either side where it sets out, square piles
    pd = deck_y - 0.04
    PFOOT = -2.2                                      # under the bed of the sea the track's shore lets down
    A, LEN, W = 0.5, 13.0, 1.6
    dx, dz = -math.sin(A), -math.cos(A)              # along the pier, away from the huts
    px0, pz0 = 0.75, Z0 + 0.3                         # where it leaves the boardwalk
    def at(t, s=0.0):
        """The pier's frame: `t` out along it, `s` across it (+ to the sea)."""
        return px0 + dx * t + dz * s, pz0 + dz * t - dx * s
    def put(t, s, y):
        x, z = at(t, s)
        return (x, y, z)
    for k in range(3):
        x, z = at(LEN * (k + 0.5) / 3)
        box((W, 0.1, LEN / 3 - 0.04), (x, pd - 0.05, z), 0xb06041 if k % 2 else wood, yaw=A)
    R = W / 2 - 0.04
    for side in (-1, 1):
        beam(put(0.3, side * R, pd + 0.42), put(LEN, side * R, pd + 0.42), 0.05, white)   # the rails
        for k in range(2, int(LEN) + 1, 2):
            box((0.05, 0.42, 0.05), put(k, side * R, pd + 0.21), white, yaw=A)
        for t in (2.0,):   # the lamps, at the root only: out along the pier they cross the pavilion's windows
            box((0.07, 1.0, 0.07), put(t, side * (R + 0.08), pd + 0.5), white, yaw=A)
            sphere(0.12, put(t, side * (R + 0.08), pd + 1.06), 0xfde4c7)
    with square():
        for k in range(6):
            for side in (-1, 1):
                x, z = at(1.0 + k * (LEN - 1.0) / 5, side * (R - 0.08))
                box((0.13, pd - PFOOT, 0.13), (x, (pd + PFOOT) / 2, z), dark, yaw=A)
    # the head: a broad deck for the pavilion and, across its seaward side,
    # the landing stage (the T), on piles
    TC = LEN + 2.2                                    # the pavilion's centre along the pier
    box((6.4, 0.1, 4.4), put(TC, 0.0, pd - 0.05), wood, yaw=A)
    box((8.6, 0.1, 1.6), put(TC + 3.0, 0.0, pd - 0.05), wood, yaw=A)
    with square():
        for (t, sx) in ((TC - 2.0, 3.0), (TC + 1.9, 3.0), (TC + 3.6, 4.1), (TC + 3.6, 1.5)):
            for side in (-1, 1):
                box((0.15, pd - PFOOT, 0.15), put(t, side * sx, (pd + PFOOT) / 2), dark, yaw=A)
    # under the head, piles every stride and a half, braced, and a deep
    # fascia round the deck's edge: on eight thin legs the pavilion hung
    # over the water
    box((6.5, 0.34, 4.5), put(TC, 0.0, pd - 0.27), dark, yaw=A)
    box((8.7, 0.34, 1.7), put(TC + 3.0, 0.0, pd - 0.27), dark, yaw=A)
    with square():
        ts = [TC - 2.0 + 1.3 * i for i in range(4)] + [TC + 3.6]
        for ti, tt in enumerate(ts):
            for si in range(5):
                sx = -3.0 + 1.5 * si
                if abs(sx) > 2.9 and tt < TC + 3.0:
                    sx = 2.95 * (1 if sx > 0 else -1)
                box((0.24, pd - PFOOT, 0.24), put(tt, sx, (pd + PFOOT) / 2), dark, yaw=A)
        for side in (-1, 1):                              # the braces along the two long sides, in X's
            for i in range(3):
                t0, t1 = TC - 2.0 + 1.3 * i, TC - 2.0 + 1.3 * (i + 1)
                beam(put(t0, side * 2.95, pd - 0.4), put(t1, side * 2.95, -0.7), 0.1, dark)
                beam(put(t1, side * 2.95, pd - 0.4), put(t0, side * 2.95, -0.7), 0.1, dark)
        for i in range(4):                                # and across the landward end, which the road sees
            s0, s1 = -3.0 + 1.5 * i, -3.0 + 1.5 * (i + 1)
            beam(put(TC - 2.0, s0, pd - 0.4), put(TC - 2.0, s1, -0.7), 0.1, dark)
            beam(put(TC - 2.0, s1, pd - 0.4), put(TC - 2.0, s0, -0.7), 0.1, dark)
    # the pavilion: white walls with a band of blue windows all round, a
    # door to the pier, a white cornice under a red hipped roof, the lantern
    # with its dome and flag on the ridge, two turrets at its landward corners
    WH, HW, HD = 1.9, 2.75, 1.6                        # wall height, half width, half depth
    box((2 * HW, WH, 2 * HD), put(TC, 0.0, pd + WH / 2), white, yaw=A)
    box((2 * HW + 0.16, 0.12, 2 * HD + 0.16), put(TC, 0.0, pd + WH - 0.09), white, yaw=A)   # the cornice
    for k in range(5):                                 # the windows, the door in the middle of the front
        sk = -2.0 + k
        for face in (-1, 1):
            if face == -1 and k == 2:
                box((0.75, 1.25, 0.08), put(TC - HD - 0.02, 0.0, pd + 0.62), 0x339cf2, yaw=A)
                continue
            box((0.6, 0.62, 0.08), put(TC + face * (HD + 0.02), sk, pd + 1.12), 0x339cf2, yaw=A)
    for k in range(3):
        for side in (-1, 1):
            box((0.08, 0.62, 0.6), put(TC - 1.0 + k, side * (HW + 0.02), pd + 1.12), 0x339cf2, yaw=A)
    ER, ET, EW = HD + 0.25, HW + 0.25, 3.3             # the eaves' half depth and width, the roof's top
    ridge = ET - ER
    roof = [put(TC - ER, -ET, pd + WH), put(TC - ER, ET, pd + WH),
            put(TC + ER, ET, pd + WH), put(TC + ER, -ET, pd + WH),
            put(TC, -ridge, pd + EW), put(TC, ridge, pd + EW)]
    poly(roof, [(0, 1, 5, 4), (2, 3, 4, 5), (1, 2, 5), (3, 0, 4)], red)
    lx, ly, lz = put(TC, 0.0, pd + EW - 0.25)
    cyl(0.45, 0.95, (lx, ly, lz), white, segs=8)                                      # the lantern
    cyl(0.47, 0.32, (lx, ly + 0.42, lz), 0x339cf2, segs=8)                             # its glazing
    sphere(0.45, (lx, ly + 0.95, lz), red, scale=(1.0, 0.85, 1.0))                    # the dome
    flag_on_pole((lx, ly + 1.3, lz), 1.0, (red, white), 'anim_sway:a=z:d=20:p=2.0#pavilion', w=0.5, fh=0.32)
    for side in (-1, 1):                                                                # the turrets
        tx, ty, tz = put(TC - HD, side * HW, pd)
        cyl(0.42, 2.45, (tx, ty, tz), white, segs=8)
        cyl(0.52, 1.1, (tx, ty + 2.45, tz), red, r2=0.03, segs=8)
    # still anglers at the ends of the landing stage, rods out to sea
    with square():
        for s, shirt in ((-3.6, red), (3.7, 0x339cf2)):
            x, z = at(TC + 3.7, s)
            tx, tz = at(TC + 4.9, s * 1.1)
            angler(x, pd, z, A + math.pi / 2, shirt, (tx, pd + 0.85, tz))
    join_still('promenade')
    # the excursion boat moored alongside the head on its sea side, which
    # the lifeguard straight looks across at (the road sees the head end on,
    # and the kerb hides the water there), bow to the landing stage: a white
    # hull with a blue band, its wheelhouse; it rides the swell and rolls a
    # little, on the sea the shore lets down
    bx, bz = at(TC + 0.6, 3.75)
    sea = SEA - SEA_SUNK
    with animated('anim_bob:h=0.05:p=3.2+sway:a=z:d=3:p=4.1#boat', (bx, sea, bz), yaw=A):
        c, sn = math.cos(A), math.sin(A)
        def B(lx, ly, lz):
            return (bx + lx * c + lz * sn, ly, bz - lx * sn + lz * c)
        box((0.8, 0.42, 1.8), B(0.0, sea + 0.08, 0.2), white, yaw=A)                   # the hull
        box((0.57, 0.42, 0.57), B(0.0, sea + 0.08, -0.72), white, yaw=A + math.pi / 4)   # its bow
        box((0.84, 0.1, 1.84), B(0.0, sea + 0.2, 0.2), 0x339cf2, yaw=A)                 # the band
        box((0.6, 0.42, 0.6), B(0.0, sea + 0.5, 0.45), white, yaw=A)                    # the wheelhouse
        box((0.64, 0.14, 0.64), B(0.0, sea + 0.62, 0.45), 0x339cf2, yaw=A)              # its windows
        box((0.7, 0.06, 0.7), B(0.0, sea + 0.74, 0.45), red, yaw=A)                     # its roof
    # gulls wheeling over the pavilion on a slow loop
    gx, gz = at(TC, 0.0)
    ring = [(gx + 3.0 * math.cos(t), pd + 5.6 + 0.5 * math.sin(2 * t), gz + 2.6 * math.sin(t))
            for t in (i / 12 * 2 * math.pi for i in range(12))]
    for i, q in enumerate(ring):
        marker('path_gulls_%d' % i, q)
    for m in range(2):
        with animated('anim_path:c=gulls:p=18:f=1:o=%.2f#g%d' % (m * 0.5, m), (0.0, 0.0, 0.0)):
            box((0.12, 0.08, 0.26), (0.0, 0.0, 0.0), 0xf8f8fb)
            box((0.62, 0.03, 0.12), (0.0, 0.03, -0.02), 0x9aa1b4)
    # an umbrella on the sand between the boardwalk and the sea, as it lies
    def sand():
        with square():
            for (x, z, c) in ((-2.2, 4.6, red),):
                umbrella((x, 0, z), 0.46, 0.72, (c, white), gores=6)
                box((0.46, 0.04, 0.24), (x - 0.38, 0.02, z + 0.1), 0xffc044, yaw=0.1)
                figure((x - 0.38, 0.04, z + 0.1), 0.1, shirt=c, legs=c, pose='lie')
    draped('sand', sand)

# ---- Riptide's seafront ----
#
# The run from the patrol's beach to the promenade is the town's front: the
# sea wall along the kerb on the sea side, its walk at the road's height, and
# across the road the terrace of guest houses and the hotel looking out over
# it, their backs in the dune. Each is a few sections, a piece each (a piece's
# box keeps the verge's apron off, so none spans the bend), every section
# built against the road as it runs past it: the centreline's x in the
# section's frame as a quadratic in z, and the deck's top at a few z (both
# read off the shipped track), so the wall and the house fronts keep one
# distance from the kerb round the bend. Both sides have the road at +X (the
# wall stands at yaw 180 on the left). They level nothing (a draped foot) and
# stand on the beach's plain, RIPTIDE_PLAIN under the road; the walls and
# houses run on under it.

RIPTIDE_PLAIN = 0.77

class riptide_road:
    """The road past a seafront section: `fit` (a, b, c), its centreline at
    x = a + b z + c z^2 in the piece's frame; `ys` [(z, y)], the deck's top."""
    def __init__(self, fit, ys):
        self.a, self.b, self.c = fit
        self.ys = sorted(ys)
    def x(self, z):
        return self.a + self.b * z + self.c * z * z
    def y(self, z):
        ys = self.ys
        if z <= ys[0][0]:
            return RIPTIDE_PLAIN + ys[0][1]
        for (z0, y0), (z1, y1) in zip(ys, ys[1:]):
            if z <= z1:
                return RIPTIDE_PLAIN + y0 + (y1 - y0) * (z - z0) / (z1 - z0)
        return RIPTIDE_PLAIN + ys[-1][1]
    def yaw(self, z):
        return math.atan(self.b + 2 * self.c * z)
    def at(self, z, d):
        """The point `d` off the centreline toward the piece at z (x, z)."""
        a = self.yaw(z)
        return self.x(z) - d * math.cos(a), z + d * math.sin(a)

def riptide_along(road, z0, z1, d0, d1, y0, y1, color, step=2.0, row=None, dy=0.0):
    """A strip `d0`..`d1` off the centreline from z0 to z1, its bottom y0 and
    top y1 over the road's top at each step (plus `dy` over the plain where
    y0 is None: from under the beach), cut in steps that turn with the road."""
    with plain_parts():   # square: a strip in short lengths
        n = max(1, int(round(abs(z1 - z0) / step)))
        out = []
        for i in range(n):
            za, zb = z0 + (z1 - z0) * i / n, z0 + (z1 - z0) * (i + 1) / n
            zm = (za + zb) / 2
            a = road.yaw(zm)
            x, z = road.at(zm, (d0 + d1) / 2)
            top = road.y(zm) + y1
            bot = (road.y(zm) + y0) if y0 is not None else dy
            o = box((abs(d1 - d0), top - bot, abs(zb - za) / math.cos(a) + 0.06), (x, (top + bot) / 2, z), color, yaw=a)
            if row is not None:
                rowed(o, row)
            out.append(o)
    return out

def riptide_lamp(road, z, d, color=0x339cf2):
    """A seafront lamp `d` off the centreline on the walk: a stout post on
    its base, a lantern and its cap, as tall as a car is long twice over."""
    with plain_parts():
        x, zz = road.at(z, d)
        y = road.y(z) + 0.05
        box((0.26, 0.3, 0.26), (x, y + 0.15, zz), color)
        box((0.13, 1.6, 0.13), (x, y + 1.0, zz), color)
        box((0.34, 0.36, 0.34), (x, y + 1.95, zz), 0xfde4c7)
        cyl(0.3, 0.26, (x, y + 2.13, zz), color, r2=0.04, segs=4, yaw=math.pi / 4)

def riptide_seat(road, z, d):
    """A seafront bench on the walk, its back to the road, facing the sea."""
    with plain_parts():
        x, zz = road.at(z, d)
        a = road.yaw(z)
        y = road.y(z) + 0.05
        c, s = math.cos(a), math.sin(a)
        def T(lx, ly, lz):
            return (x + lx * c + lz * s, y + ly, zz - lx * s + lz * c)
        box((0.42, 0.1, 1.3), T(0.0, 0.36, 0.0), 0x9a7b55, yaw=a)
        box((0.1, 0.42, 1.3), T(0.2, 0.62, 0.0), 0x9a7b55, yaw=a)
        for e in (-0.55, 0.55):
            box((0.42, 0.36, 0.1), T(0.0, 0.18, e), 0x38383d, yaw=a)

def riptide_sea_wall(road, z0, z1, gap=None):
    """The sea wall from z0 to z1: the walk (paving) from just past the
    beach strip to 8.9 off the centreline at the road's height, its face of
    dressed stone down to the beach, the cream coping proud of the face and
    the cream parapet along the sea edge (open over `gap`, (z0, z1), where
    steps go down)."""
    riptide_along(road, z0, z1, 5.1, 9.05, None, -0.07, 'grey', row=15, dy=-0.5)       # the wall's body
    riptide_along(road, z0, z1, 5.1, 8.85, -0.1, 0.05, 'grey', row=4)                 # the walk
    riptide_along(road, z0, z1, 8.75, 9.25, -0.05, 0.1, 0xfde4c7)                     # the coping
    spans = [(z0, z1)] if gap is None else [(z0, gap[0]), (gap[1], z1)]
    for (a, b) in spans:
        if abs(b - a) > 0.2:
            riptide_along(road, a, b, 8.8, 9.1, 0.05, 0.42, 0xfde4c7, step=1.5)     # the parapet

def riptide_steps(road, za, zb, n=5):
    """Stone steps down the wall's face to the sand, along it from za (at the
    walk) to zb (on the beach)."""
    for i in range(n):
        t0, t1 = i / n, (i + 1) / n
        zm = za + (zb - za) * (t0 + t1) / 2
        x, z = road.at(zm, 9.6)
        top = road.y(zm) + 0.05 - (road.y(zm) + 0.05) * t1
        a = road.yaw(zm)
        rowed(box((0.9, top + 0.5, abs(zb - za) / n + 0.04), (x, (top - 0.5) / 2, z), 'grey', yaw=a), 8)

@piece(1.0)
def seafront_wall_a():
    # Riptide: the sea wall where it sets out from the patrol's beach: its
    # end pier, steps down to the sand, lamps and a bench facing the sea.
    road = riptide_road((9.497, -0.0112, -0.00014), [(-6.0, -0.01), (6.0, 0.0)])
    riptide_sea_wall(road, -5.8, 5.8, gap=(2.6, 4.4))
    riptide_steps(road, 2.7, 5.4)
    x, z = road.at(5.6, 8.95)                                                     # the end pier
    y = road.y(5.6)
    box((0.6, y + 1.2, 0.6), (x, (y + 1.2 - 0.5) / 2, z), 0xfde4c7)
    sphere(0.3, (x, y + 0.82, z), 0xfde4c7)
    for zl in (-4.6, 0.4):
        riptide_lamp(road, zl, 8.55)
    riptide_seat(road, -2.1, 7.6)
    join_still('wall')
    on_a_rise()

@piece(1.0)
def seafront_wall_b():
    # Riptide: the sea wall's shelter, a seafront one: four posts and a
    # glazed back to the road under a red hipped roof, its bench to the sea.
    road = riptide_road((9.513, 0.0204, -0.01106), [(-5.96, 0.18), (-3.0, 0.11), (0.0, 0.05), (3.0, 0.0), (6.0, -0.01)])
    riptide_sea_wall(road, -5.8, 5.8)
    zc = 0.6
    x, z = road.at(zc, 7.3)
    a = road.yaw(zc)
    y = road.y(zc) + 0.05
    c, s = math.cos(a), math.sin(a)
    def T(lx, ly, lz):
        return (x + lx * c + lz * s, y + ly, z - lx * s + lz * c)
    for lx in (-0.55, 0.55):
        for lz in (-0.95, 0.95):
            box((0.14, 1.5, 0.14), T(lx, 0.75, lz), 0xfff6eb, yaw=a)
    box((0.06, 0.9, 1.8), T(0.55, 0.85, 0.0), 0x8ecae6, yaw=a)                   # the glazed back
    box((0.42, 0.1, 1.7), T(-0.25, 0.36, 0.0), 0x9a7b55, yaw=a)                  # its bench
    box((1.4, 0.12, 2.2), T(0.0, 1.55, 0.0), 0xfff6eb, yaw=a)
    for side in (-1, 1):                                                          # the roof
        box((0.85, 0.1, 2.3), T(side * 0.36, 1.82, 0.0), 0xcf534f, yaw=a, roll=side * 0.62)
    box((0.12, 0.14, 1.4), T(0.0, 2.08, 0.0), 0xcf534f, yaw=a)
    for zl in (-4.0, 4.2):
        riptide_lamp(road, zl, 8.55)
    join_still('wall')
    on_a_rise()

@piece(1.0)
def seafront_wall_c():
    # Riptide: the seafront's clock on a bastion of the wall standing out
    # onto the beach at the bend, where the straight from the patrol's beach
    # points: a stone foot, a white shaft, the clock stage with a face to
    # every side, the red spire and its vane: the front's tall mark.
    road = riptide_road((9.5, 0.0015, -0.01644), [(-5.96, 0.26), (-3.0, 0.32), (0.0, 0.30), (3.0, 0.24), (6.0, 0.17)])
    riptide_sea_wall(road, -5.8, 5.8, gap=(-1.75, 1.75))
    # the bastion: the wall's body, walk and parapet carried out round it
    y = road.y(0.0) + 0.05
    x0, _ = road.at(0.0, 0.0)
    rowed(box((2.6, y + 0.43, 3.6), (x0 - 10.1, (y - 0.07 - 0.5) / 2, 0.0), 'grey'), 15)
    rowed(box((2.5, 0.15, 3.5), (x0 - 10.05, y - 0.025, 0.0), 'grey'), 4)
    box((0.3, 0.47, 3.8), (x0 - 11.3, y + 0.19, 0.0), 0xfde4c7)                     # its parapet
    for e in (-1, 1):
        box((2.5, 0.47, 0.3), (x0 - 10.1, y + 0.19, e * 1.75), 0xfde4c7)
    # the clock tower
    tx = x0 - 10.0
    box((1.3, 0.5, 1.3), (tx, y + 0.25, 0.0), 'grey')
    box((0.9, 2.5, 0.9), (tx, y + 1.75, 0.0), 0xfff6eb)
    box((0.96, 0.16, 0.96), (tx, y + 1.3, 0.0), 0x339cf2)                         # a blue band
    box((1.15, 0.14, 1.15), (tx, y + 3.05, 0.0), 0xfde4c7)                        # the clock stage's sill
    box((1.05, 0.95, 1.05), (tx, y + 3.6, 0.0), 0xfff6eb)
    cy = y + 3.6
    for k in (-1, 1):                                                              # a face to every side
        cyl(0.4, 0.06, (tx + k * 0.555 - (0.06 if k < 0 else 0.0), cy, 0.0), 0x38383d, segs=12, axis='across')
        cyl(0.33, 0.06, (tx + k * 0.585 - (0.06 if k < 0 else 0.0), cy, 0.0), 0xfff6eb, segs=12, axis='across')
        box((0.04, 0.26, 0.06), (tx + k * 0.66, cy + 0.1, 0.0), 0x38383d)
        box((0.04, 0.06, 0.2), (tx + k * 0.66, cy, 0.08), 0x38383d)
        cyl(0.4, 0.06, (tx, cy, k * 0.555 - (0.06 if k < 0 else 0.0)), 0x38383d, segs=12, axis='along')
        cyl(0.33, 0.06, (tx, cy, k * 0.585 - (0.06 if k < 0 else 0.0)), 0xfff6eb, segs=12, axis='along')
        box((0.06, 0.26, 0.04), (tx, cy + 0.1, k * 0.66), 0x38383d)
        box((0.2, 0.06, 0.04), (tx + 0.08, cy, k * 0.66), 0x38383d)
    box((1.2, 0.14, 1.2), (tx, y + 4.13, 0.0), 0xfde4c7)
    cyl(0.84, 1.1, (tx, y + 4.2, 0.0), 0xcf534f, r2=0.04, segs=4, yaw=math.pi / 4)  # the spire
    box((0.07, 0.6, 0.07), (tx, y + 5.5, 0.0), 0x38383d)
    with animated('anim_sway:a=y:d=40:p=6.0#vane', (tx, y + 5.6, 0.0)):
        box((0.05, 0.14, 0.6), (tx, y + 5.65, 0.1), 0x38383d)
        box((0.05, 0.22, 0.14), (tx, y + 5.65, -0.22), 0x38383d)
    for zl in (-4.6, 4.6):
        riptide_lamp(road, zl, 8.55)
    join_still('wall')
    on_a_rise()

@piece(1.0)
def seafront_wall_d():
    # Riptide: the sea wall's last length before the promenade's boardwalk:
    # the tea kiosk on the walk under its striped awning, two tables under
    # big umbrellas, steps down to the sand and lamps.
    road = riptide_road((9.5, -0.0011, -0.01625), [(-5.96, 0.01), (-3.0, 0.07), (0.0, 0.13), (3.0, 0.20), (6.0, 0.27)])
    riptide_sea_wall(road, -5.8, 5.8, gap=(-5.6, -3.6))
    riptide_steps(road, -3.7, -5.6)
    zc = 1.2
    x, z = road.at(zc, 7.6)
    a = road.yaw(zc)
    y = road.y(zc) + 0.05
    c, s = math.cos(a), math.sin(a)
    def T(lx, ly, lz):
        return (x + lx * c + lz * s, y + ly, z - lx * s + lz * c)
    box((1.1, 1.15, 1.7), T(-0.1, 0.575, 0.0), 0xfff6eb, yaw=a)                   # the kiosk
    box((1.3, 0.12, 1.9), T(-0.1, 1.2, 0.0), 0x339cf2, yaw=a)
    for i in range(4):                                                             # its awning to the road
        box((0.55, 0.08, 1.9 / 4), T(0.65, 1.05, -0.71 + i * 0.475), (0xff5040, 0xfff6eb)[i % 2], yaw=a, roll=0.4)
    box((0.12, 0.5, 1.5), T(0.47, 0.55, 0.0), 0x339cf2, yaw=a)                    # the counter
    for (lz, cols) in ((-2.2, (0xff5040, 0xfff6eb)), (3.6, (0x339cf2, 0xfff6eb))):
        px, pz = road.at(zc + lz, 7.5)
        py = road.y(zc + lz) + 0.05
        umbrella((px, py, pz), 0.95, 1.35, cols, gores=8)
        box((0.5, 0.08, 0.5), (px, py + 0.5, pz), 0xfff6eb)                         # the table
        box((0.12, 0.5, 0.12), (px, py + 0.25, pz), 0x38383d)
    for zl in (-2.8, 5.0):
        riptide_lamp(road, zl, 8.55)
    join_still('wall')
    on_a_rise()

def riptide_house(road, zc, w, floors, wall, roof, bay=False, balcony=False, front=6.3, dep=2.8, door=0x339cf2):
    """A seaside house in the terrace, its front `front` off the centreline
    at zc, `w` along the road, `floors` storeys of 0.78: windows in white
    frames, its door, a gabled roof along the road with chimneys on the
    ridge; a bay window up its first two floors, or a balcony on the first.
    It runs on under the beach and its back into the dune."""
    a = road.yaw(zc)
    xf, zf = road.at(zc, front + dep / 2)
    y = road.y(zc) + 0.05
    c, s = math.cos(a), math.sin(a)
    def T(lx, ly, lz):
        return (xf + lx * c + lz * s, y + ly, zf - lx * s + lz * c)
    H = 0.2 + 0.78 * floors
    box((dep, H + 1.0, w), T(0.0, (H - 1.0) / 2, 0.0), wall, yaw=a)
    fx = dep / 2
    # the roof: two slabs meeting over the ridge along the road, the gables filled
    rh = 0.75
    ang = math.atan2(rh, dep / 2)
    run = (dep / 2 + 0.2) / math.cos(ang)
    for side in (-1, 1):
        box((run, 0.12, w + 0.24), T(side * (dep / 2 + 0.2) / 2, H + rh - 0.5 * (dep / 2 + 0.2) * math.tan(ang) + 0.06, 0.0),
            roof, yaw=a, roll=side * ang)
    for e in (-1, 1):
        poly([T(-dep / 2, H, e * w / 2), T(dep / 2, H, e * w / 2), T(0.0, H + rh, e * w / 2)], [(0, 1, 2)], wall)
    box((0.3, 0.6, 0.3), T(0.0, H + rh + 0.1, w / 2 - 0.35), wall, yaw=a)            # the chimney
    box((0.36, 0.08, 0.36), T(0.0, H + rh + 0.42, w / 2 - 0.35), 'grey', yaw=a)
    with plain_parts():   # its dressing square-edged: the frame keeps the chamfer
        # the front
        box((0.08, 0.66, 0.42), T(fx + 0.02, 0.35, -w / 4), 0xfff6eb, yaw=a)            # the door in its frame
        box((0.08, 0.6, 0.34), T(fx + 0.05, 0.32, -w / 4), door, yaw=a)
        cols = (-w / 4, w / 4) if w < 2.0 else (-w / 3, 0.0, w / 3)
        for f in range(floors):
            wy = 0.2 + 0.78 * f + 0.42
            for cz in cols:
                if f == 0 and abs(cz + w / 4) < 0.5:
                    continue
                if bay and f < 2 and cz == cols[-1]:
                    continue
                box((0.08, 0.48, 0.42), T(fx + 0.02, wy, cz), 0xfff6eb, yaw=a)
                box((0.08, 0.38, 0.32), T(fx + 0.05, wy, cz), 0x4f5260, yaw=a)
        if bay:                                                                         # a bay window, two floors
            bz = cols[-1]
            box((0.42, 1.5, 0.78), T(fx + 0.2, 0.2 + 0.75, bz), wall, yaw=a)
            for f in range(2):
                box((0.08, 0.42, 0.56), T(fx + 0.43, 0.2 + 0.78 * f + 0.42, bz), 0x8ecae6, yaw=a)
            box((0.56, 0.1, 0.92), T(fx + 0.22, 1.76, bz), roof, yaw=a)
        if balcony:                                                                     # a balcony on the first floor
            box((0.4, 0.1, w * 0.7), T(fx + 0.2, 0.98, 0.0), 0xfff6eb, yaw=a)
            box((0.08, 0.32, w * 0.7), T(fx + 0.38, 1.18, 0.0), 0xfff6eb, yaw=a)

def riptide_pavement(road, z0, z1):
    """The pavement before the terrace, at the road's height past the beach strip."""
    riptide_along(road, z0, z1, 5.1, 6.4, None, 0.05, 'grey', row=4, dy=-0.5)

@piece(1.0)
def seafront_hotel():
    # Riptide: the seafront hotel and its neighbours, across the road from
    # the sea wall where the straight from the patrol's beach comes in: four
    # floors, white with blue balconies all along, a flat roof behind a
    # parapet with its red sign and two flags; the guest houses either side.
    road = riptide_road((8.989, 0.0287, 0.0124), [(-7.0, -0.01), (-3.5, 0.0), (0.0, 0.06), (3.5, 0.14), (7.0, 0.22)])
    riptide_pavement(road, -7.0, 7.0)
    riptide_house(road, -6.2, 2.2, 3, 0xd0e8ff, 0x4f5260, bay=True)
    riptide_house(road, -4.0, 2.2, 2, 0xfde4c7, 0xcf534f, balcony=True)
    zc, w, dep, floors = -0.6, 4.6, 3.0, 4
    a = road.yaw(zc)
    xf, zf = road.at(zc, 6.3 + dep / 2)
    y = road.y(zc) + 0.05
    c, s = math.cos(a), math.sin(a)
    def T(lx, ly, lz):
        return (xf + lx * c + lz * s, y + ly, zf - lx * s + lz * c)
    H = 0.25 + 0.78 * floors
    fx = dep / 2
    box((dep, H + 1.0, w), T(0.0, (H - 1.0) / 2, 0.0), 0xfff6eb, yaw=a)
    box((dep + 0.12, 0.16, w + 0.12), T(0.0, H, 0.0), 0xfde4c7, yaw=a)            # the cornice
    box((dep, 0.32, w), T(0.0, H + 0.24, 0.0), 0xfff6eb, yaw=a)                     # the parapet
    with plain_parts():
        box((0.1, 0.9, 1.1), T(fx + 0.04, 0.45, 0.0), 0xfde4c7, yaw=a)                  # the entrance
        box((0.1, 0.78, 0.8), T(fx + 0.08, 0.4, 0.0), 0x339cf2, yaw=a)
        box((0.7, 0.1, 1.4), T(fx + 0.3, 0.98, 0.0), 0xff5040, yaw=a)                   # its canopy
        for f in range(floors):
            wy = 0.25 + 0.78 * f + 0.42
            for k in range(5):
                cz = -w / 2 + 0.5 + k * (w - 1.0) / 4
                if f == 0 and abs(cz) < 0.7:
                    continue
                box((0.08, 0.46, 0.44), T(fx + 0.02, wy, cz), 0xfde4c7, yaw=a)
                box((0.08, 0.38, 0.34), T(fx + 0.05, wy, cz), 0x4f5260, yaw=a)
            if f > 0:                                                                   # a balcony along each upper floor
                box((0.36, 0.08, w - 0.3), T(fx + 0.18, wy - 0.36, 0.0), 0xfff6eb, yaw=a)
                box((0.08, 0.26, w - 0.3), T(fx + 0.34, wy - 0.2, 0.0), 0x339cf2, yaw=a)
        # the sign on the roof, to the road and the sea: a red board, white bars on it
        box((0.18, 0.62, 3.0), T(0.4, H + 0.7, 0.0), 0xff5040, yaw=a)
        for k in range(5):
            box((0.08, 0.3, 0.3), T(0.52, H + 0.72, -1.1 + k * 0.55), 0xfff6eb, yaw=a)
        for e in (-1, 1):
            box((0.12, 0.62, 0.12), T(0.4, H + 0.2, e * 1.2), 0x38383d, yaw=a)
        for k, e in enumerate((-1, 1)):                                                 # two flags on the roof
            px, py, pz = T(-0.6, H + 0.4, e * (w / 2 - 0.35))
            box((0.1, 1.5, 0.1), (px, py + 0.75, pz), 0xfff6eb)
            with animated('anim_sway:a=x:d=20:p=%.1f#hotel%d' % (1.9 + 0.3 * k, k), (px, py + 1.5, pz)):
                box((0.05, 0.42, 0.7), (px, py + 1.26, pz + 0.38), (0x339cf2, 0xff5040)[k])
    riptide_house(road, 3.4, 2.2, 3, 0xf1976c, 0xcf534f, balcony=True, door=0xfff6eb)
    riptide_house(road, 5.6, 2.2, 2, 0xfff6eb, 0x339cf2, bay=True)
    join_still('terrace')
    on_a_rise()

@piece(1.0)
def seafront_terrace():
    # Riptide: the guest houses round the bend, a row of them in the
    # seaside's colours, each its own height, with bays and balconies, their
    # doors to the road and the dune behind them.
    road = riptide_road((9.0, -0.0017, 0.01645), [(-7.0, 0.22), (-3.5, 0.30), (0.0, 0.31), (3.5, 0.24), (7.0, 0.16)])
    riptide_pavement(road, -7.0, 7.0)
    for (zc, w, fl, wall, roof, bay, bal) in ((-5.6, 2.2, 3, 0xffc044, 0x4f5260, False, True),
                                               (-3.3, 2.2, 3, 0xfff6eb, 0x339cf2, True, False),
                                               (-1.0, 2.2, 2, 0x61cb8b, 0xcf534f, False, False),
                                               (1.3, 2.2, 3, 0xa0a8c9, 0x4f5260, True, False),
                                               (3.6, 2.2, 3, 0xfde4c7, 0xcf534f, False, True),
                                               (5.9, 2.2, 2, 0xd0e8ff, 0x4f5260, True, False)):
        riptide_house(road, zc, w, fl, wall, roof, bay=bay, balcony=bal)
    join_still('terrace')
    on_a_rise()

@piece(1.0)
def seafront_cafe():
    # Riptide: the terrace's end by the promenade: two more houses and the
    # corner cafe, its striped awning over tables on the pavement.
    road = riptide_road((9.008, 0.013, 0.01811), [(-7.0, 0.16), (-3.5, 0.08), (0.0, 0.02), (3.5, -0.01), (7.0, -0.01)])
    riptide_pavement(road, -7.0, 7.0)
    riptide_house(road, -5.6, 2.2, 3, 0xf2bf99, 0xcf534f, bay=True)
    riptide_house(road, -3.3, 2.2, 2, 0xfff6eb, 0x4f5260, balcony=True, door=0xff5040)
    riptide_house(road, 0.0, 4.4, 2, 0xfff6eb, 0xcf534f, door=0xff5040)
    # the cafe's awning along its front, red and white, and its tables
    zc = 0.0
    a = road.yaw(zc)
    for i in range(7):
        x, z = road.at(zc - 1.9 + i * 0.63, 5.95)
        box((0.7, 0.08, 0.64), (x, road.y(zc) + 0.95, z), (0xff5040, 0xfff6eb)[i % 2], yaw=a, roll=0.35)
    for lz in (-1.2, 1.2):
        x, z = road.at(zc + lz, 5.6)
        y = road.y(zc + lz) + 0.05
        box((0.5, 0.08, 0.5), (x, y + 0.5, z), 0xfff6eb)
        box((0.12, 0.5, 0.12), (x, y + 0.25, z), 0x38383d)
    riptide_house(road, 3.3, 2.2, 3, 0xd0e8ff, 0xcf534f, bay=True)
    riptide_house(road, 5.5, 2.2, 2, 0x61cb8b, 0x4f5260, balcony=True)
    join_still('terrace')
    on_a_rise()

# ---- Driftwood's storm coast ----

@piece(1.0)
def lighthouse():
    # Driftwood: the light on the point where the dune pass comes out onto
    # the beach, at a real lighthouse's size (some 35 m: a car is 0.9): the
    # round tower in the red and white of the gantry's posts on its stone
    # foot, the gallery with its rail, and the lantern on top where the lamp
    # turns behind the glazing bars; the keeper's cottage at its foot, its
    # chimney smoking in its walled yard, and before them the station's
    # flagstaff, its flag streaming in the wind. The pass drives straight at
    # it for the length of the diagonal. +X is the road.
    white, red, dark = 0xfff6eb, 0xcf534f, 0x38383d
    TX, TZ = -1.7, 0.0                                   # the tower, back from the road
    H, R0, R1, B = 6.0, 0.8, 0.52, 0.3                    # its height, its radii, its foot's top
    def r_at(y):
        return R0 + (R1 - R0) * (y - B) / H
    cyl(1.1, B + 0.3, (TX, -0.3, TZ), 'grey', r2=1.02, segs=12)                   # the stone foot
    cyl(R0, H, (TX, B, TZ), white, r2=R1, segs=12)                                 # the tower
    for y0, y1 in ((1.5, 2.6), (3.7, 4.8)):                                        # its red bands
        cyl(r_at(y0) + 0.03, y1 - y0, (TX, y0, TZ), red, r2=r_at(y1) + 0.03, segs=12)
    # the door to the road under a red hood, a window up each white stretch
    box((0.12, 0.72, 0.42), (TX + r_at(0.6) - 0.02, B + 0.36, TZ), 'slate')
    box((0.22, 0.08, 0.56), (TX + r_at(1.1) + 0.02, B + 0.78, TZ), red)
    for y in (3.15, 5.35):
        box((0.1, 0.36, 0.24), (TX + r_at(y) - 0.01, y, TZ), 'slate')
    # the gallery: a deck proud of the tower, its rail on posts
    G = B + H
    cyl(0.95, 0.14, (TX, G - 0.02, TZ), dark, segs=12)
    for k in range(8):
        a = k / 8 * 2 * math.pi
        box((0.08, 0.36, 0.08), (TX + 0.86 * math.cos(a), G + 0.3, TZ + 0.86 * math.sin(a)), dark)
    torus(0.86, 0.03, (TX, G + 0.46, TZ), dark, segs=12)
    # the lantern: a white drum, the lamp behind eight glazing bars, the red
    # cupola, its ball and vane
    cyl(0.56, 0.3, (TX, G + 0.12, TZ), white, segs=10)
    L0, L1 = G + 0.42, G + 1.12
    for k in range(8):
        a = (k + 0.5) / 8 * 2 * math.pi
        box((0.07, L1 - L0, 0.07), (TX + 0.5 * math.cos(a), (L0 + L1) / 2, TZ + 0.5 * math.sin(a)), dark, yaw=-a)
    cyl(0.2, L1 - L0, (TX, L0, TZ), 0xffc044, segs=8)                             # the lamp
    with animated('anim_spin:a=y:w=1.1#lamp', (TX, (L0 + L1) / 2, TZ)):            # its lens, turning
        box((0.74, 0.4, 0.12), (TX, (L0 + L1) / 2, TZ), 0xffc044)
        for s in (-1, 1):
            box((0.22, 0.22, 0.04), (TX + 0.2 * s, (L0 + L1) / 2, TZ + 0.07), white)
            box((0.22, 0.22, 0.04), (TX + 0.2 * s, (L0 + L1) / 2, TZ - 0.07), white)
    cyl(0.6, 0.12, (TX, L1, TZ), red, segs=10)
    cyl(0.56, 0.5, (TX, L1 + 0.12, TZ), red, r2=0.1, segs=10)
    box((0.16, 0.16, 0.16), (TX, L1 + 0.68, TZ), dark)
    box((0.04, 0.4, 0.04), (TX, L1 + 0.9, TZ), dark)
    box((0.04, 0.06, 0.36), (TX, L1 + 1.0, TZ + 0.06), dark)
    # the keeper's house beside it, at a house's size beside a car (the
    # first was a shed a car long): whitewashed, two rooms long under a red
    # roof, its door and two windows to the road, a porch over the door, a
    # chimney smoking on the ridge, a lean-to store against the tower
    # end, and a low stone wall round its yard with the gate to the road
    CX, CZ = TX - 0.3, TZ + 3.6
    gabled_house(CX, CZ, 1.9, 3.4, 1.15, 0.75, white, red)
    box((0.06, 0.86, 0.56), (CX + 0.97, 0.43, CZ), white)                        # the door, in its frame
    box((0.06, 0.78, 0.46), (CX + 0.99, 0.39, CZ), 0x339cf2)
    fx = CX + 0.95
    for dz in (-1.05, 1.05):                                                       # the windows either side of the door
        box((0.08, 0.5, 0.56), (fx + 0.02, 0.68, CZ + dz), white)
        box((0.08, 0.4, 0.46), (fx + 0.05, 0.68, CZ + dz), 'slate')
    box((0.5, 0.08, 0.9), (fx + 0.22, 0.98, CZ), red, roll=-0.25)                  # the porch
    for dz in (-0.38, 0.38):
        box((0.07, 0.95, 0.07), (fx + 0.44, 0.47, CZ + dz), white)
    box((0.34, 1.1, 0.34), (CX, 1.75, CZ + 1.0), 'grey')                             # the chimney, on the ridge
    box((0.42, 0.1, 0.42), (CX, 2.33, CZ + 1.0), dark)
    marker('anim_smoke', (CX, 2.5, CZ + 1.0))
    box((1.3, 1.1, 0.9), (CX - 0.2, 0.25, CZ - 2.1), white)                        # the lean-to store
    box((1.5, 0.1, 1.1), (CX - 0.2, 0.86, CZ - 2.15), red, pitch=0.2)
    with plain_parts():                                                            # the yard wall, the gate's gap to the road
        WX = fx + 1.1
        for (z0, z1) in ((CZ - 2.6, CZ - 0.5), (CZ + 0.5, CZ + 2.4)):
            box((0.22, 0.36, z1 - z0), (WX, 0.18, (z0 + z1) / 2), 'grey')
        box((WX - CX + 0.9, 0.36, 0.22), ((WX + CX - 0.9) / 2, 0.18, CZ + 2.4), 'grey')
        for dz in (-0.5, 0.5):
            box((0.26, 0.5, 0.26), (WX, 0.25, CZ + dz), 'grey')
    figure((fx + 0.75, 0, CZ - 0.2), 0.0, shirt=0x6794d9, legs=0x38383d, hair=0xfff6eb)
    # the flagstaff before them: a white mast stayed to the ground, the
    # station's flag flying from its head across the piece (+Z), so the road
    # sees the cloth, and the storm cone hoisted on its halyard as one plain
    # red shape (the black cone on a crosstree read as an arrow on a frame)
    MX, MZ = 0.6, TZ - 2.4
    cyl(0.22, 0.24, (MX, 0, MZ), 'grey', segs=6)
    box((0.11, 4.0, 0.11), (MX, 2.0, MZ), white)
    box((0.16, 0.16, 0.16), (MX, 4.06, MZ), red)
    with plain_parts():
        for s in (-1, 1):
            beam((MX, 3.0, MZ), (MX, 0.0, MZ + s * 1.2), 0.04, 0x9aa1b4)
    with animated('anim_sway:a=x:d=20:p=1.6#pennant', (MX, 3.95, MZ)):
        box((0.05, 0.6, 0.55), (MX, 3.62, MZ + 0.33), red)
        box((0.05, 0.6, 0.5), (MX, 3.6, MZ + 0.82), white, yaw=0.1)
        box((0.05, 0.22, 0.24), (MX, 3.6, MZ + 0.82), red, yaw=0.1)
    # rocks bedded in the sand round the foot
    for (x, z, k, yw) in ((TX + 1.3, TZ - 0.9, 0.42, 0.4), (TX - 1.1, TZ - 1.0, 0.5, 1.3),
                          (TX + 1.2, TZ + 0.9, 0.3, 2.1), (MX + 0.5, MZ + 0.9, 0.28, 0.7)):
        boulder((x, 0, z), k=k, yaw=yw)
    join_still('light')

def net_hut(x, z, w, d, h, door, trim):
    """A fishermen's net hut, tall and narrow and tarred a warm brown, its
    gable and doors to the road (+X): the shed, its weathered boards' laps,
    its pitched roof, the ground door and the loft door over it with the
    hoist beam out over that. Its walls run on under its foot (the piece
    stands on the land as it is and the land rises behind it)."""
    box((w, h + 0.6, d), (x, (h - 0.6) / 2, z), 'brown')
    for y in (h * 0.3, h * 0.62):                                         # the boards' laps
        box((w + 0.04, 0.06, d + 0.04), (x, y, z), 'tan')
    prism([(z - d / 2 - 0.1, h), (z + d / 2 + 0.1, h), (z, h + 0.42 * d)], x, w + 0.16, 'grey')
    for sgn in (-1, 1):                                                   # white barge boards on the road gable
        beam((x + w / 2 + 0.09, h - 0.02, z + sgn * (d / 2 + 0.1)), (x + w / 2 + 0.09, h + 0.42 * d, z), 0.07, 0xfde4c7)
    box((0.06, 0.66, d * 0.5 + 0.1), (x + w / 2 + 0.01, 0.35, z), trim)
    box((0.06, 0.6, d * 0.5), (x + w / 2 + 0.03, 0.32, z), door)
    box((0.06, 0.34, d * 0.42), (x + w / 2 + 0.03, h * 0.7, z), door)
    box((0.36, 0.09, 0.09), (x + w / 2 + 0.16, h * 0.7 + 0.27, z), 0x8a6a46)

@piece(1.0)
def net_huts():
    # Driftwood: the fishermen's end of the beach by the start straight, at
    # their real size: a row of net huts with their doors to the road, two
    # storeys at most and tarred a warm brown (black, the row read from the
    # road as one black block), backed into the grassy bank behind them
    # (tracks.js); the beach boat hauled up the sand on its skids beside
    # them with the capstan that winched it up, nets heaped to dry, fish
    # boxes stacked, pots and floats, and a gull on a ridge watching the
    # cars. It stands on the land as it is and levels nothing (its gear is
    # draped), so the bank runs on up behind it. The row runs along the road
    # (+Z); +X is the road.
    # (five small ones in a row read from the road as one dark jumble: three
    # now, tall and apart, each its own height and door colour)
    for (z, h, door, trim) in ((-2.7, 2.3, 0xcf534f, 0xfde4c7), (-0.6, 2.9, 0x6794d9, 0xfde4c7),
                               (1.5, 2.5, 0xffc044, 0xfde4c7)):
        net_hut(-0.7, z, 1.15, 1.35, h, door, trim)
    # the beach boat hauled up on its skids past the row's end, bow to the
    # sea (-X), the capstan behind that winched it up; skids, keel and the
    # capstan's barrel run on under the sand
    BX, BZ = -0.4, -5.6
    for dz in (-0.35, 0.35):
        box((2.6, 0.5, 0.14), (BX - 0.2, -0.17, BZ + dz), 0x8a6a46)              # the skids
    def b(size, dx, dy, dz, color, yaw=0.0):
        box(size, (BX + dx, dy, BZ + dz), color, yaw=yaw)
    b((1.7, 0.42, 0.78), 0.1, 0.33, 0, 0x6794d9)                                 # the hull
    b((0.5, 0.42, 0.5), -0.85, 0.33, 0, 0x6794d9, yaw=math.pi / 4)               # its bow
    b((1.75, 0.08, 0.82), 0.1, 0.46, 0, 0xcf534f)                                # the wale
    b((1.8, 0.06, 0.86), 0.1, 0.56, 0, 0xfff6eb)                                 # the gunwale
    b((0.5, 0.4, 0.6), 0.45, 0.75, 0, 0xfff6eb)                                  # the cuddy
    b((0.54, 0.06, 0.64), 0.45, 0.96, 0, 0xcf534f)
    box((0.08, 1.3, 0.08), (BX - 0.3, 1.1, BZ), 0x8a6a46)                         # the mast, stepped down
    box((0.6, 0.16, 0.06), (BX - 0.3, 1.65, BZ), 0xcf534f)                         # its flag
    CX, CZ = BX + 2.6, BZ
    cyl(0.28, 1.0, (CX, -0.5, CZ), 0x8a6a46, segs=8)                              # the capstan
    cyl(0.34, 0.1, (CX, 0.5, CZ), 0x8a6a46, segs=8)
    for k in range(2):
        box((1.3, 0.08, 0.08), (CX, 0.45, CZ), 0x9a6a46, yaw=k * math.pi / 2)
    tube([(CX - 0.28, 0.25, CZ), (BX + 1.3, 0.22, BZ - 0.1), (BX + 0.95, 0.3, BZ)], 0.03, 0xfde4c7, wire=True)
    gull((-0.7, 2.9 + 0.42 * 1.35, -0.6), math.pi / 2, 'anim_watch:r=24#gull')
    join_still('huts')
    # nets heaped by the huts, their floats along them, fish boxes stacked by
    # a door, two crab pots: on the sand as it lies
    def gear():
        with plain_parts():
            for (x, z, c) in ((0.45, -1.65, 0x61cb8b),):
                box((0.55, 0.18, 0.7), (x, 0.09, z), c, yaw=0.3 * z)
                box((0.4, 0.14, 0.45), (x + 0.05, 0.25, z - 0.05), c, yaw=0.3 * z + 0.4)
                for k in range(3):
                    box((0.09, 0.09, 0.09), (x + 0.3, 0.06, z - 0.25 + k * 0.25), 0xff7e44)
            for k, (dz, y) in enumerate(((0.0, 0.0), (0.56, 0.0), (0.28, 0.3))):
                crab_pot((0.5, y, 0.25 + dz), 0.0)
    draped('gear', gear)

# ---- Cove's island ----

@piece(1.0)
def smugglers_cave():
    # Cove: the pirates' cave in the foot of the island's peak, where its
    # jungle comes down to the start straight by the grid: an outcrop of the
    # island's own grey rock (Skull Rock's stone) standing out of the green
    # slope, grass on its top where the hill runs over it, and in its foot
    # the way in, which goes DOWN: a stone sill, steps and handrails
    # dropping into the dark under a roof pitched down after them, rock
    # either side of the mouth and over it, a lantern, a barrel and a chest
    # open on its gold, the Jolly Roger on the rock's brow. (A scarp of pale sandstone was tried
    # twice and read as a lump of dough with a black hole.) It stands on the
    # land as it is and levels nothing (its haul is draped); tracks.js lifts
    # it onto the slope the foothill's chords draw at its foot. No one keeps
    # the door. +X is the road.
    rock = ('grey', WET)
    for k, (x, z, s, sq, y) in enumerate(((-4.6, 0.0, 9.0, 0.8, 1.0), (-1.7, -4.6, 5.6, 0.85, 0.3),
                                          (-1.4, 4.2, 5.2, 0.85, 0.3), (-4.4, -2.6, 7.0, 0.8, 1.4),
                                          (-4.2, 3.0, 7.4, 0.76, 1.4), (0.6, -3.4, 2.4, 0.7, -0.1),
                                          (0.8, 3.4, 2.0, 0.7, -0.1), (-0.6, -7.6, 3.0, 0.6, -0.1))):
        stone(x, z, s, 1.57 + 0.4 * jitter(k, 1, 9.0), 60.0 + k, squat=sq, rock=rock, top='green', y=y)
    for o in bpy.context.scene.objects:                 # Skull Rock's mid-dark slate, at one value
        if o.type == 'MESH' and o.name.startswith('stone') and o.get('row') is None:
            if o['swatch'] == 'grey':
                rowed(o, 14)
            elif o['swatch'] == 'slate':
                rowed(o, 1)
    # the way in, and down: a stone sill at the threshold, then steps going
    # down into the hill between plank cheeks, a handrail either side
    # dropping with them, the roof boards pitched down after them into the
    # dark, and the island's rock standing round the opening (a flat black
    # door in a frame said shed, not cave)
    wood, plank = 0x8a6a46, 0x9a7b55
    X1, HW, HH, SILL = 1.0, 1.25, 2.4, 0.45
    for k, (x, z, s, sq, y) in enumerate(((X1 - 0.5, -(HW + 1.5), 3.8, 1.0, -0.1), (X1 - 0.4, HW + 1.4, 3.4, 1.05, -0.1),
                                          (X1 - 2.2, 0.0, 6.0, 0.6, HH - 0.1), (X1 + 0.5, -(HW + 0.5), 1.6, 0.8, -0.05),
                                          (X1 + 0.6, HW + 0.6, 1.4, 0.8, -0.05))):
        stone(x, z, s, 1.57 + 0.5 * k, 80.0 + k, squat=sq, rock=rock, top='green' if k == 2 else 'grey', y=y)
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and o.name.startswith('stone') and o.get('row') is None:
            if o['swatch'] == 'grey':
                rowed(o, 14)
            elif o['swatch'] == 'slate':
                rowed(o, 1)
    # the dark stands close behind the props: the hill's own ground runs
    # through the passage further in and would show in the frame
    box((0.2, HH + 0.4, 2 * HW - 0.1), (X1 - 0.8, HH / 2 - 0.2, 0.0), 0x101014)
    box((2.9, 0.5, 2 * HW - 0.1), (X1 - 1.4, -0.15, 0.0), 0x101014)                       # and under the steps
    rowed(box((0.9, SILL + 0.3, 2 * HW + 0.5), (X1 + 0.25, SILL / 2 - 0.15, 0.0), 'grey'), 8)   # the sill
    for i in range(7):
        box((0.36, 0.1, 2 * HW - 0.4), (X1 - 0.25 - 0.36 * i, SILL - 0.05 - 0.17 * i, 0.0), plank)
    for sz in (-1, 1):
        box((3.0, HH + 0.6, 0.12), (X1 - 1.5, HH / 2 - 0.3, sz * HW), plank)               # the cheeks
        box((0.28, HH + 0.2, 0.28), (X1, HH / 2, sz * (HW + 0.06)), wood)                  # the props
        beam((X1 + 0.1, SILL + 0.95, sz * (HW - 0.22)), (X1 - 2.4, SILL - 0.2, sz * (HW - 0.22)), 0.09, wood)   # the rail
        box((0.09, 0.95, 0.09), (X1 + 0.1, SILL + 0.47, sz * (HW - 0.22)), wood)
    box((0.32, 0.32, 2 * HW + 0.8), (X1, HH + 0.2, 0.0), wood)                              # the lintel
    box((3.0, 0.12, 2 * HW + 0.1), (X1 - 1.45, HH - 0.42, 0.0), plank, roll=0.3)            # the roof, pitched down inward
    box((0.05, 0.4, 0.05), (X1 + 0.18, HH - 0.15, HW - 0.3), 0x38383d)                     # the lantern's bracket
    box((0.16, 0.28, 0.18), (X1 + 0.2, HH - 0.45, HW - 0.3), 0xffc044)                     # the lantern
    kit_flag('flag-pirate-high', (-4.6, 4.9, 0.6), math.radians(90), 0.6, 'anim_sway:a=x:d=24:p=2.2')
    join_still('cave')
    # the haul at the threshold, on the land as it lies
    def gear():
        kit('pirate', 'barrel', (1.7, 0, -1.9), yaw=0.4, scale=0.2)
        kit('pirate', 'chest', (1.8, 0, 1.9), yaw=math.radians(-80), scale=0.17)
        for (gx, gz) in ((2.05, 1.75), (2.0, 2.07), (2.15, 1.93)):
            box((0.07, 0.04, 0.07), (gx, 0.02, gz), 'yellow', yaw=gx * 3)
    draped('haul', gear)

def palm_clump(tag, cx, cz, palms, bushes):
    """Palms as ONE rigid part laid on the land at its pivot (anim_drape):
    draped vertex by vertex, a crown on a slope tipped flat along it. It
    leans a few degrees in the breeze about its foot, each clump on its own
    beat and axis. `palms` are (dx, dz, h, lean, yaw degrees) off the pivot,
    their trunks running on under their feet, so the slope can fall away
    from the pivot without showing air. `bushes` (the scrub that stood at
    their feet) are no longer built: a rigid bush a stride downhill of the
    pivot hung over the slope, a draped one was sheared into a green blade,
    and one sunk deep enough to stay grounded stood out of the hill as a
    green crystal. The hill's own green carries the scrub."""
    n = ord(tag[-1])
    sway = 'sway:a=%s:d=3:p=%.1f' % ('xz'[n % 2], 3.2 + 0.3 * (n % 5))
    with animated('anim_drape+%s#%s' % (sway, tag), (cx, 0.0, cz)):
        for (dx, dz, h, lean, yw) in palms:                # close in: a palm a stride uphill of the pivot stood buried to its crown
            palm((cx + 0.5 * dx, 0, cz + 0.5 * dz), h=h, lean=lean, yaw=math.radians(yw), trunk='tan', sink=1.1)

@piece(1.0)
def jungle_grove():
    # Cove: the jungle where the island's green foothills come down to the
    # road: palms of mixed heights leaning every way, a stride or two apart,
    # in clumps with the island's round scrub at their feet, so the hill
    # reads as jungle from the seat and not as a lawn. Each clump is a rigid
    # part laid on the slope at its pivot (palm_clump); a few fallen
    # coconuts lie draped, which also stands the piece on the land as it is.
    # +X is the road; it runs along the road (+Z).
    # (round 10: the jungle grown to the island's own height, the tallest
    # palms twice a racer's sight line over the kerb, so the island reads as
    # jungle from the seat and not as a beach with a few palms)
    palm_clump('a', 0.2, -5.5, ((0.4, -0.6, 3.6, 0.3, 200), (-1.2, 0.9, 5.0, 0.15, 340)),
               ((1.0, 0.6, 0.42), (-0.4, -1.3, 0.35)))
    palm_clump('b', -1.0, -1.0, ((0.5, -0.4, 4.4, 0.25, 60), (-0.9, 1.3, 3.8, 0.35, 250), (1.1, 1.6, 3.1, 0.2, 130)),
               ((0.9, -1.0, 0.45), (-0.3, 0.2, 0.4), (1.6, 0.4, 0.3)))
    palm_clump('c', 0.1, 3.6, ((-0.6, -0.5, 5.3, 0.2, 290), (0.8, 0.9, 3.9, 0.3, 20)),
               ((0.9, -0.6, 0.4), (-0.6, 1.1, 0.35)))
    palm_clump('d', -1.6, 7.2, ((0.3, 0.2, 4.3, 0.3, 160), (-0.8, -1.2, 3.3, 0.25, 80)),
               ((0.9, 0.9, 0.42),))
    def litter():
        with plain_parts():
            for (x, z) in ((0.9, -4.6), (-0.2, 0.9), (1.2, 4.4), (-0.6, 6.2)):
                box((0.13, 0.13, 0.13), (x, -0.5, z), 0x9a6a46, yaw=x + z)
    draped('litter', litter)

@piece(1.0)
def palm_stand():
    # Cove: a short stand of palms for the inside of a tight bend, where a
    # grove's straight run would reach the kerb at its ends: three clumps in
    # some 8 u (palm_clump), a few fallen coconuts draped. +X is the road.
    palm_clump('a', 0.2, -3.0, ((0.3, -0.4, 2.8, 0.25, 40), (-0.9, 0.7, 2.2, 0.3, 230)), ((0.9, 0.5, 0.45),))
    palm_clump('b', -1.0, 0.6, ((0.5, 0.2, 3.1, 0.15, 300), (-0.6, -0.9, 2.5, 0.3, 120), (0.2, 1.4, 2.0, 0.25, 190)),
               ((1.0, -0.6, 0.42), (-0.7, 1.1, 0.4)))
    palm_clump('c', 0.1, 3.8, ((0.0, 0.0, 2.6, 0.3, 160), (-1.0, 0.8, 2.2, 0.2, 20)), ((0.9, 0.4, 0.42),))
    def litter():
        with plain_parts():
            for (x, z) in ((0.8, -2.2), (-0.1, 1.9), (0.7, 4.3)):
                box((0.13, 0.13, 0.13), (x, -0.5, z), 0x9a6a46, yaw=x + z)
    draped('litter', litter)

@piece(1.0)
def pirate_lookout():
    # Cove: the crew's lookout over the east beach, and the rope bridge they
    # cross the road by, from the jungle to it: stood on the road's own line
    # (tracks.js, lat 0) where the east straight runs down to the bay, so
    # the straight drives at it and under it. On the beach side (-X) the
    # lookout proper, a timber tower at its real size (some 20 m), four
    # stout legs splayed and braced, its crow's nest a plank hut on the
    # platform under a thatch, the Jolly Roger flying over it and a cannon
    # at its foot run out to the sea; on the island side (+X) a plain
    # platform tower among the palms; between their platforms the bridge,
    # planks slung on two rope rails, sagging over the road with the height
    # of a gantry under it. Every bar a fist thick at a car's scale (round
    # 10: the first lookout was a lattice of hairlines). It levels nothing
    # (its shot is draped): the legs run on under its feet.
    wood, dark, plank, rope = 0x8a6a46, 0x6e5b3a, 0xb06041, 0xcbb794
    P0 = 4.6                                                   # the platforms over the plain
    def tower(cx, spread0, spread1, tall=True):
        g = spread0 + (spread0 - spread1) * 0.8 / P0
        for sx in (-1, 1):
            for sz in (-1, 1):
                beam((cx + sx * g, -0.8, sz * g), (cx + sx * spread1, P0, sz * spread1), 0.3, wood)
        for y0, y1 in ((0.3, 2.4), (2.4, P0 - 0.2)):          # the braces, crossing on each face
            f0, f1 = y0 / P0, y1 / P0
            r0, r1 = spread0 + (spread1 - spread0) * f0, spread0 + (spread1 - spread0) * f1
            for sz in (-1, 1):
                beam((cx - r0, y0, sz * r0), (cx + r1, y1, sz * r1), 0.16, dark)
                beam((cx + r0, y0, sz * r0), (cx - r1, y1, sz * r1), 0.16, dark)
            for sx in (-1, 1):
                beam((cx + sx * r0, y0, -r0), (cx + sx * r1, y1, r1), 0.16, dark)
                beam((cx + sx * r0, y0, r0), (cx + sx * r1, y1, -r1), 0.16, dark)
        box((2 * spread1 + 0.7, 0.24, 2 * spread1 + 0.7), (cx, P0 + 0.12, 0.0), plank)   # the platform
        # the ladder up the face the cars come at (-Z)
        for sx in (-1, 1):
            beam((cx + sx * 0.3, -0.8, -spread0 - 0.5), (cx + sx * 0.3, P0, -spread1 - 0.15), 0.12, wood)
        for i in range(9):
            t = (i + 0.5) / 9
            z = -spread0 - 0.5 + (spread0 + 0.5 - spread1 - 0.15) * t
            box((0.7, 0.1, 0.1), (cx, -0.8 + (P0 + 0.8) * t, z), dark)
    # the lookout, on the beach side
    LX = -8.6
    tower(LX, 1.5, 0.95)
    # its crow's nest: a plank hut on the platform, a window to the sea and
    # one to the road, a thatch over it
    box((1.9, 1.3, 1.9), (LX, P0 + 0.89, 0.0), 0x9a7b55)
    for (wx, wz) in ((LX - 0.96, 0.0), (LX + 0.96, 0.0)):
        box((0.06, 0.5, 0.8), (wx, P0 + 1.05, wz), 0x38383d)
    box((0.8, 0.5, 0.06), (LX, P0 + 1.05, -0.96), 0x38383d)
    cyl(1.55, 0.9, (LX, P0 + 1.5, 0.0), 0xd9b054, r2=0.12, segs=8)                    # the thatch
    kit_flag('flag-pirate-high', (LX, P0 + 1.9, 0.0), math.radians(90), 0.7, 'anim_sway:a=x:d=24:p=2.0')
    # the island's platform among the palms
    IX = 8.6
    tower(IX, 1.2, 0.85)
    for k in range(4):                                         # its rail of posts round three sides
        a = k * math.pi / 2
        box((0.16, 0.9, 0.16), (IX + 1.15 * math.cos(a + math.pi / 4) * 1.414, P0 + 0.6,
                                1.15 * math.sin(a + math.pi / 4) * 1.414), wood)
    palm((IX + 2.4, 0, 1.6), h=5.6, lean=0.18, yaw=math.radians(20), sink=1.0)
    palm((IX + 1.8, 0, -2.4), h=4.6, lean=0.25, yaw=math.radians(300), sink=1.0)
    # the rope bridge between the platforms, sagging over the road: planks
    # across it on two rope rails, the rails on posts at both ends
    A, B = LX + 1.3, IX - 1.1
    n = 24
    drop = 0.5
    def deck_y(t):
        return P0 + 0.12 - drop * 4 * t * (1 - t)
    for i in range(n):
        t = (i + 0.5) / n
        x = A + (B - A) * t
        box(((B - A) / n - 0.06, 0.12, 1.4), (x, deck_y(t), 0.0), plank if i % 4 else 0x9a6a46)
        for sz in (-0.72, 0.72):                               # the side boards: a band seen from the road
            box(((B - A) / n + 0.02, 0.36, 0.1), (x, deck_y(t) + 0.12, sz), wood)
    for sz in (-0.72, 0.72):
        rail = [(A + (B - A) * t, deck_y(t) + 1.0 + 0.15 * 4 * t * (1 - t), sz) for t in [i / 8 for i in range(9)]]
        tube(rail, 0.07, rope, res=3)
        foot = [(A + (B - A) * t, deck_y(t) - 0.06, sz) for t in [i / 8 for i in range(9)]]
        tube(foot, 0.07, rope, res=3)
        for i in range(1, 8):                                  # the hangers from rail to foot
            t = i / 8
            x = A + (B - A) * t
            beam((x, deck_y(t) - 0.06, sz), (x, deck_y(t) + 1.0 + 0.15 * 4 * t * (1 - t), sz), 0.09, rope)
        for x in (A, B):                                       # the posts the rails hang from
            box((0.2, 1.4, 0.2), (x, P0 + 0.8, sz), wood)
    join_still('lookout')
    def shot():
        with plain_parts():
            kit('pirate', 'cannon-mobile', (LX - 2.6, 0, 1.6), yaw=math.radians(-90), scale=0.65)
            for (dx, dz) in ((0.0, 0.0), (0.42, 0.0), (0.2, 0.36)):
                sphere(0.2, (LX - 1.6 + dx, 0.2, 2.6 + dz), 0x38383d, subdiv=1)
    draped('shot', shot)

@piece(1.0)
def jungle_ruin():
    # Cove: an old stepped temple the jungle has half taken back, on the
    # island's flank outside the S where the camera swings toward it, the
    # pirates' flag planted on its shrine (their treasure is in there, as
    # Skull Rock across the road says): four tiers of grey stone gone green
    # on their treads, a broad stair up its road face (+X) to the shrine
    # and its dark doorway, a stone head either side of the stair's foot,
    # a few blocks tumbled at its foot.
    # Stone at the reef's mid values, never pale. +X is the road.
    stone_c, moss = 'grey', 'green'
    tiers = ((7.2, 1.1), (5.7, 1.0), (4.3, 1.0), (3.0, 0.9))
    y = -0.4
    for k, (w, h) in enumerate(tiers):
        rowed(box((w, h + (0.4 if k == 0 else 0.0), w), (0.0, y + (h + (0.4 if k == 0 else 0.0)) / 2, 0.0), stone_c),
              4 + 2 * k)
        top = y + h + (0.4 if k == 0 else 0.0)
        rowed(box((w - 0.25, 0.1, w - 0.25), (0.0, top + 0.03, 0.0), moss), 10)
        y = top
    # the shrine on the top, its dark door to the road under a heavy lintel
    rowed(box((2.0, 1.4, 2.0), (0.0, y + 0.7, 0.0), stone_c), 5)
    rowed(box((2.5, 0.35, 2.5), (0.0, y + 1.55, 0.0), stone_c), 4)
    rowed(box((2.1, 0.1, 2.1), (0.0, y + 1.76, 0.0), moss), 10)
    box((0.08, 0.95, 0.8), (1.02, y + 0.5, 0.0), 0x38383d)
    kit_flag('flag-pirate-high', (0.3, y + 1.7, 0.6), math.radians(90), 0.6, 'anim_sway:a=x:d=24:p=2.2')
    # the stair up the road face, its own lighter stone, cheeks either side
    n = 14
    for i in range(n):
        t = i / n
        x = 3.6 - 3.0 * t
        rowed(box((0.45, 0.3, 1.8), (x + 0.15, -0.4 + 0.3 * (i + 0.5) * (y + 0.4) / (0.3 * n), 0.0), stone_c), 1)
    for sz in (-1.05, 1.05):
        beam((3.9, -0.2, sz), (0.6, y + 0.1, sz), 0.35, 0x868ba1)
    # a stone head either side of the stair's foot: a block of a face, its
    # brow, eyes and mouth cut dark, a car and a half tall
    for sz in (-1.9, 1.9):
        rowed(box((1.0, 1.5, 1.0), (4.2, 0.55, sz), stone_c), 6)
        rowed(box((1.1, 0.25, 1.1), (4.2, 1.35, sz), moss), 12)
        for ez in (-0.22, 0.22):
            box((0.06, 0.18, 0.2), (4.72, 0.95, sz + ez), 0x38383d)
        box((0.06, 0.14, 0.55), (4.72, 0.45, sz), 0x38383d)
    # the blocks tumbled at its foot
    for k, (x, z, s) in enumerate(((4.4, -3.6, 0.8), (5.0, 3.2, 0.7), (-2.0, 4.4, 0.9))):
        rowed(box((s * 1.3, s * 0.8, s), (x, s * 0.25, z), stone_c, yaw=0.7 * k, roll=0.2), 8)
    join_still('ruin')


# ---- round 6: Tidepool's Seal Rock and car park ----

WET, WEED = 'slate', 'green'      # rock the tide leaves wet, the weed band at its foot

def scenery_wheel(cx, cy, cz, r, w, yaw=0.0, hub=0xfde4c7):
    """A parked vehicle's wheel centred at (cx, cy, cz), its axle across the
    vehicle (the piece's X turned by `yaw`): a round tyre of sixteen sides,
    dark, and a pale hub standing a little proud of it on both faces, with
    a darker cap, so it reads as a wheel from the road (a square block of
    tyre colour, or an eight-sided disc, read as a brick under the van)."""
    c, s = math.cos(yaw), math.sin(yaw)
    def at(d):                                           # a point `d` along the axle from the wheel's middle
        return (cx + d * c, cy, cz - d * s)
    cyl(r, w, at(-w / 2), 0x2a2735, segs=16, axis='across', yaw=yaw, smooth=True)
    cyl(0.56 * r, w + 0.04, at(-w / 2 - 0.02), hub, segs=12, axis='across', yaw=yaw)
    cyl(0.2 * r, w + 0.07, at(-w / 2 - 0.035), 0x9aa1b4, segs=8, axis='across', yaw=yaw, stem=True)

def camper(x, z, yaw, lower, upper=0xfff6eb, boards=(), pop=False):
    """A camper van parked on the sand, its nose to +Z turned by `yaw`: some
    1.5 u long and taller than a racer, two-tone in a colour no racer wears,
    its window band round the upper body, a pop-top when `pop`, surfboards
    (colours) strapped on the roof. Never read as a rival."""
    c, s = math.cos(yaw), math.sin(yaw)
    def b(size, dx, dy, dz, color, pitch=0.0):
        box(size, (x + dx * c + dz * s, dy, z - dx * s + dz * c), color, yaw=yaw, pitch=pitch)
    for sx in (-1, 1):
        for sz in (-0.46, 0.46):
            scenery_wheel(x + sx * 0.3 * c + sz * s, 0.18, z - sx * 0.3 * s + sz * c, 0.18, 0.13, yaw)
    b((0.66, 0.36, 1.5), 0, 0.36, 0, lower)
    b((0.66, 0.34, 1.34), 0, 0.71, -0.06, upper)
    b((0.68, 0.16, 1.0), 0, 0.73, -0.12, 'sky')                      # the window band
    b((0.56, 0.22, 0.06), 0, 0.66, 0.62, 'sky', pitch=-0.25)         # the windscreen
    for sz in (-0.77, 0.77):
        b((0.66, 0.08, 0.06), 0, 0.22, sz, 'grey')                   # the bumpers
    b((0.6, 0.06, 1.24), 0, 0.91, -0.08, upper)                      # the roof
    if pop:
        b((0.58, 0.24, 0.9), 0, 1.06, -0.2, 0xfde4c7)                # the pop-top's tent
    for k, col in enumerate(boards):
        b((0.17, 0.05, 1.1), -0.17 + 0.17 * k, 0.97 + (0.24 if pop else 0.0), -0.08, col)

def surfboard(x, z, yaw, color, stripe, lean=0.25, h=0.7):
    """A surfboard stood on its tail and leant back (roll) against whatever
    is behind it, `h` long, its stripe down the middle."""
    half = [(0.0, 0.0), (0.05, 0.02), (0.08, 0.12), (0.09, 0.32), (0.08, 0.5), (0.05, 0.64), (0.0, h)]
    outline = [(zz, y) for zz, y in half] + [(-zz, y) for zz, y in reversed(half[1:-1])]
    o = prism([(z + zz, y) for zz, y in outline], x, 0.04, color)
    o.rotation_euler = (0.0, -lean, yaw)

def kiosk(x, z, yaw):
    """The rock-poolers' kiosk: a white hut with a red and white striped
    awning to the road (+X), buckets, spades and crab lines hung under it."""
    c, s = math.cos(yaw), math.sin(yaw)
    def b(size, dx, dy, dz, color, roll=0.0):
        box(size, (x + dx * c + dz * s, dy, z - dx * s + dz * c), color, yaw=yaw, roll=roll)
    b((0.9, 0.8, 1.2), 0, 0.4, 0, 0xfff6eb)
    b((1.0, 0.08, 1.3), 0, 0.84, 0, 0x339cf2)
    for i in range(4):
        b((0.5, 0.05, 1.3 / 4), 0.62, 0.74, -0.49 + i * 0.325, 0xff5040 if i % 2 == 0 else 0xfff6eb, roll=0.35)
    b((0.06, 0.06, 1.1), 0.8, 0.58, 0, 0x9a6a46)                     # the rail under the awning
    for k, col in enumerate((0xffc044, 0x339cf2, 0xff5040, 0x22c46e)):
        b((0.1, 0.12, 0.1), 0.8, 0.44, -0.4 + k * 0.27, col)         # buckets hung on it
    for k in range(3):
        b((0.02, 0.24, 0.02), 0.8, 0.44, -0.27 + k * 0.27, 0x38383d)  # the crab lines
    b((0.12, 0.3, 0.6), 0.46, 0.15, 0, 0x339cf2)                     # the counter


# a seal: dark and sleek, wet slate with a paler muzzle. The first were pale
# fawn blocks and read as loaves, or as stones on the rock
SEAL, SEAL_MUZZLE = 'slate', 'grey'

def hauled_seal(x, y, z, yaw, k):
    """A seal hauled out, its head to +X turned by `yaw`, at a seal's size
    beside a car (a little over one long): a smooth dark body tapering to
    its tail flippers, the chest propped up on its fore flippers and the
    head raised, which is the shape that says seal from the road; the head
    turns up now and then (a gesture, then a long rest)."""
    c, s = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + dx * c + dz * s, y + dy, z - dx * s + dz * c)
    def lump(r, p, scale, color=SEAL, row=18):
        o = sphere(r, p, color, subdiv=2, scale=scale, flat=False, yaw=yaw)
        return rowed(o, row)
    lump(0.24, at(-0.12, 0.17, 0.0), (2.3, 0.8, 1.0))                       # the body
    lump(0.21, at(0.3, 0.3, 0.0), (1.2, 1.25, 0.95))                        # the chest, propped up
    rowed(box((0.3, 0.05, 0.36), at(-0.68, 0.05, 0.0), SEAL, yaw=yaw + 0.3), 24)   # the tail flippers
    for sz in (-1, 1):
        rowed(box((0.26, 0.05, 0.16), at(0.34, 0.04, sz * 0.24), SEAL, yaw=yaw + sz * 0.5), 24)
    with animated('anim_sway:a=z:d=22:p=%.1f:r=0.7#seal%d' % (6.0 + 0.9 * (k % 5), k), at(0.38, 0.42, 0.0), yaw):
        lump(0.15, at(0.5, 0.58, 0.0), (1.25, 1.0, 0.95), row=14)           # the head
        rowed(box((0.12, 0.1, 0.14), at(0.68, 0.55, 0.0), SEAL_MUZZLE, yaw=yaw), 4)   # the muzzle

@piece(1.0)
def seal_rock():
    # Tidepool: the seals' rock off the east bend, a tidal island at its real
    # size (some 20 u across, 5 u to its grassy top), low and broad in the
    # open water the shore brings round it (tracks.js): its foot dark and wet
    # with the weed band the tide leaves, grey rock above, a cap of grass.
    # Built of a dozen lumps run together, so its faces break into buttresses
    # and clefts (three lumps made a rock of a dozen flat sides). Six seals
    # lie hauled out on the low skirts of rock at the waterline that face the
    # road, dark and sleek against the grey; one bobs in the water off them,
    # and gulls wheel over the top. The east run points dead at it for five
    # seconds: dark rock on blue sea.
    rock = ('grey', WET)
    for k, (x, z, s, sq, y) in enumerate(((0.0, 0.0, 12.0, 0.72, -0.6), (-3.8, 3.6, 9.0, 0.62, -0.4),
                                          (3.4, -3.6, 7.0, 0.6, -0.3), (3.6, 2.6, 6.5, 0.7, -0.3),
                                          (-2.6, -4.4, 7.5, 0.6, -0.4), (-6.2, -0.6, 6.0, 0.55, -0.3),
                                          (0.6, 6.2, 6.0, 0.55, -0.3), (5.6, -0.4, 4.6, 0.6, -0.2),
                                          (-0.8, -6.6, 5.0, 0.5, -0.3))):
        stone(x, z, s, 0.4 + 1.3 * k, 31.0 + k, squat=sq, rock=rock, top='green' if k < 5 else 'grey', y=y)
    # the wet foot and its weed band, round its seaward sides in the water
    for k in range(10):
        a = k / 10 * 2 * math.pi + 0.3
        if math.cos(a) > 0.3:                           # not up the beach: there they lay on dry sand as flat tiles
            continue
        stone(9.6 * math.cos(a), 8.8 * math.sin(a), 5.0, a, 40.0 + k, squat=0.2,
              rock=(WET, 'dark'), top=WEED if k % 2 else WET, y=-0.5)
    # the skirts the seals lie on: low humps of the rock sloping into the
    # sea on the road side (+X), and the seals on their backs
    SKIRTS = ((7.6, -4.6, 6.0, 0.8), (8.0, 2.8, 5.4, 2.1), (2.2, 9.0, 5.0, 0.3))
    for k, (x, z, s, yw) in enumerate(SKIRTS):
        stone(x, z, s, yw, 35.0 + 7 * k, squat=0.22, rock=rock, top='grey', y=-0.35)
    spots = ((7.0, -5.2, 2.2), (8.3, -3.8, 1.5), (7.4, 2.2, 0.5), (8.6, 3.5, 1.5), (1.6, 8.6, 1.8), (2.9, 9.5, 0.8))
    for k, (x, z, yw) in enumerate(spots):
        hauled_seal(x, 0.12, z, yw, k)
    # one in the water off the road-side skirt, its head bobbing on the swell
    with animated('anim_bob:h=0.07:p=3.4#swimmer', (11.6, 0.0, -1.0)):
        rowed(sphere(0.17, (11.6, 0.14, -1.0), SEAL, subdiv=2, scale=(1.2, 1.0, 0.95), flat=False), 14)
        rowed(box((0.12, 0.1, 0.14), (11.8, 0.16, -1.0), SEAL_MUZZLE), 4)
    # gulls wheeling over the top on a slow loop
    ring = [(5.0 * math.cos(t), 9.5 + 0.6 * math.sin(2 * t), 4.4 * math.sin(t)) for t in (i / 12 * 2 * math.pi for i in range(12))]
    for i, p in enumerate(ring):
        marker('path_gulls_%d' % i, p)
    for m in range(2):
        with animated('anim_path:c=gulls:p=16:f=1:o=%.2f#g%d' % (m * 0.5, m), (0.0, 0.0, 0.0)):
            box((0.12, 0.08, 0.26), (0.0, 0.0, 0.0), 0xf8f8fb)
            box((0.62, 0.03, 0.12), (0.0, 0.03, -0.02), 0x9aa1b4)
    join_still('rock')

@piece(1.0)
def rock_poolers_park():
    # Tidepool: the rock-poolers' car park on the sand by the start straight,
    # at the vehicles' real size: camper vans and a minibus, all bigger than
    # a racer and in colours no racer wears, nosed toward the sea (-X); the
    # striped kiosk hung with buckets and crab lines, its flag, surfboards
    # leant on a van. No one about: the tide is out and they are on the reef.
    # +X is the road; the row runs along it (+Z).
    for (z, lower, boards, pop) in ((-4.2, 'sky', (0xffc044,), True), (-2.4, 'tan', (), False),
                                    (2.0, 'lavender', (0xff5040, 0x339cf2), False), (3.8, 'salmon', (), True)):
        camper(-0.8, z, -math.pi / 2, lower, boards=boards, pop=pop)
    # the minibus at the row's end, longer and taller still
    c, s = math.cos(-math.pi / 2), math.sin(-math.pi / 2)
    def bus(size, dx, dy, dz, color):
        box(size, (-0.6 + dx * c + dz * s, dy, 6.4 - dx * s + dz * c), color, yaw=-math.pi / 2)
    for sx in (-1, 1):
        for sz in (-0.8, 0.8):
            scenery_wheel(-0.6 + sx * 0.35 * c + sz * s, 0.2, 6.4 - sx * 0.35 * s + sz * c, 0.2, 0.14, -math.pi / 2)
    bus((0.78, 0.8, 2.4), 0, 0.62, 0, 0xfde4c7)
    bus((0.8, 0.22, 2.0), 0, 0.78, -0.1, 'sky')
    bus((0.8, 0.12, 2.42), 0, 0.3, 0, 'tan')
    kiosk(0.4, 0.0, 0.0)
    # the car park's gravel under the vans and the bus, and its track to the kerb
    gravel_yard(((-1.9, 0.4, -5.4, 7.9), (-2.1, 0.1, -4.9, 4.6), (-1.7, 0.7, 4.9, 7.7), (0.2, 4.6, -3.6, -1.4)))
    flag_on_pole((0.9, 0, 1.0), 1.4, (0x339cf2, 0xfff6eb), 'anim_sway:a=z:d=20:p=2.2#park')
    for k, (col, st) in enumerate(((0xffc044, 0xff5040), (0x339cf2, 0xfff6eb), (0x22c46e, 0xffc044))):
        surfboard(-0.2 + 0.03 * k, 2.95 + 0.0 * k + 0.22 * k - 0.22, 0.0, col, st, lean=0.3)
    join_still('park')

# ---- round 8: the three beaches' stories at the kerb ----
#
# Past a `shore` the beach is the plain (TtpRenderer beachMask) and low road
# stands most of a unit over it behind its kerb, so what lies low on the sea
# side is hidden from the seat. These pieces stand over the kerb or they are
# nothing: rock in knuckles a car's height and more, trees with their limbs
# up, masts and sails. Each is one stretch of its beach, a dozen units or so
# along the road (+Z) with its road side at +X, so its box stays off the
# verge: the band lays no apron inside a piece's footprint.

# ---- Tidepool: the reef beside the road ----

REEF_TOP = 'lavender'   # what faces the sky on the reef: its own swatch, so reef_tone() can set it apart

def reef_tone():
    """The reef's rock in three mid-dark values whatever its height
    (rowed()): what faces the sky, what the sun strikes, what is turned from
    it, slate from a half down to a third. Down the full ramp a tall
    knuckle's top came out as pale as the road and the wet ledges at its
    foot near black, and rock by water wants neither."""
    for o in bpy.context.scene.objects:
        if o.type != 'MESH' or not o.name.startswith('stone') or o.get('row') is not None:
            continue
        if o['swatch'] == REEF_TOP:
            rowed(o, 29)
        elif o['swatch'] == 'grey':
            rowed(o, 17)
        elif o['swatch'] == 'slate':
            rowed(o, 1)
        elif o['swatch'] == 'dark':
            o['swatch'] = 'slate'
            rowed(o, 14)

# ---- Riptide: the surf club, the camp, the contest, the fleet ----

def pennant(at, h, colors, tag, lean=0.0):
    """A feather banner `h` tall on its pole, its cloth across the road's
    line (in the piece's X-Y plane) so the cars coming see its face, two
    colours, stirring about the pole."""
    x, y, z = at
    box((0.06, h, 0.06), (x, y + h / 2, z), 0xfff6eb)
    w = 0.26 * h
    with animated('anim_sway:a=y:d=16:p=%.1f#%s' % (2.2 + 0.2 * (ord(tag[-1]) % 4), tag), (x, y, z)):
        poly([(x - 0.03, y + 0.24 * h, z), (x - w, y + 0.3 * h, z), (x - 1.1 * w, y + 0.62 * h, z),
              (x - 0.03, y + 0.62 * h, z)], [(0, 1, 2, 3)], colors[0])
        poly([(x - 0.03, y + 0.62 * h, z), (x - 1.1 * w, y + 0.62 * h, z), (x - 0.75 * w, y + 0.92 * h, z),
              (x - 0.03, y + h, z)], [(0, 1, 2, 3)], colors[1])

@piece(1.0)
def surf_club():
    # Riptide: the surf lifesaving club where the lap sets out along the
    # beach: the boat hall, white with the patrol's red band, its two doors
    # to the road (+X), boards racked along its wall; the watch room on its
    # roof, glazed all round under a red roof; the signal mast over it
    # flying the red and yellow; the rescue boat on its trailer on the apron
    # and the patrol's flags along the sand either side. A real club's size
    # (a hall for the boats, three storeys to the mast's foot), so it stands
    # over the kerb from down the straight. No one about.
    white, red, yellow, wood = 0xfff6eb, 0xff5040, 0xffc044, 0x9a7b55
    box((4.4, 0.14, 6.6), (-0.4, 0.07, 0.0), wood)                                   # the apron's deck
    HX, HW, HD, HH = -1.2, 2.4, 5.4, 1.35
    box((HW, HH, HD), (HX, 0.14 + HH / 2, 0.0), white)
    box((HW + 0.04, 0.24, HD + 0.04), (HX, 0.14 + HH - 0.2, 0.0), red)
    box((HW + 0.5, 0.12, HD + 0.5), (HX, 0.14 + HH + 0.06, 0.0), 0x9aa1b4)           # the flat roof, a terrace
    fx = HX + HW / 2
    for z in (0.5, 2.0):
        box((0.06, 0.92, 1.2), (fx + 0.02, 0.14 + 0.46, z), 0x4f5260)               # the boat doors
    for z in (-2.2, -1.3):
        box((0.06, 0.36, 0.56), (fx + 0.02, 0.8, z), 0x8ecae6)
    box((0.08, 0.2, 1.7), (fx + 0.04, 1.14, -1.75), yellow)                           # the club's name board
    box((0.1, 0.07, 2.0), (fx + 0.12, 0.62, -1.75), wood)                             # the board rack
    for k, (col, st) in enumerate(((red, white), (yellow, red), (0x339cf2, white), (red, yellow), (white, 0x339cf2))):
        surfboard(fx + 0.1, -2.55 + k * 0.4, 0.0, col, st, lean=0.16, h=0.95)
    # the terrace's rail, toward the road and both ends
    RY = 0.14 + HH + 0.12
    with plain_parts():
        for z in (-HD / 2 - 0.15, HD / 2 + 0.15):
            box((HW + 0.3, 0.06, 0.06), (HX, RY + 0.36, z), white)
        box((0.06, 0.06, HD + 0.3), (fx + 0.15, RY + 0.36, 0.0), white)
        for k in range(7):
            box((0.06, 0.36, 0.06), (fx + 0.15, RY + 0.18, -HD / 2 - 0.15 + k * (HD + 0.3) / 6), white)
    # the watch room on the roof, at the hall's far end from the stair
    WZ, WW, WH = -1.5, 1.7, 0.9
    box((WW, WH, WW + 0.2), (HX, RY + WH / 2, WZ), white)
    box((WW + 0.04, 0.34, WW + 0.24), (HX, RY + 0.52, WZ), 0x8ecae6)                  # glazed all round
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((0.12, WH, 0.12), (HX + sx * WW / 2, RY + WH / 2, WZ + sz * (WW + 0.2) / 2), white)
    for sz in (-1, 1):
        box((WW + 0.5, 0.1, 0.72 * (WW + 0.7)), (HX, RY + WH + 0.24, WZ + sz * (WW + 0.7) / 4), red, pitch=-sz * 0.5)
    box((WW + 0.56, 0.12, 0.2), (HX, RY + WH + 0.52, WZ), 0x9aa1b4)
    # the stair up the hall's end to the terrace
    for i in range(8):
        t = (i + 0.5) / 8
        box((0.7, 0.08, 0.26), (HX + 0.4, 0.14 + (HH + 0.1) * t, HD / 2 + 2.1 - 2.0 * t), wood)
    beam((HX + 0.4, 0.08, HD / 2 + 2.15), (HX + 0.4, 0.1 + HH, HD / 2 + 0.05), 0.14, wood)                # its stringer
    # the signal mast through the terrace: a yard, the patrol's flags
    MX, MZ, MH = HX + 0.2, 1.4, 4.6
    box((0.12, MH, 0.12), (MX, MH / 2, MZ), white)
    box((0.07, 0.07, 1.8), (MX, MH - 0.9, MZ), white)
    for sz in (-1, 1):
        beam((MX, MH - 0.1, MZ), (MX, RY + 0.1, MZ + sz * 1.6), 0.04, 0x9aa1b4)       # the stays
    flag_on_pole((MX, MH - 0.6, MZ), 0.7, (red, yellow), 'anim_sway:a=z:d=22:p=2.1#mast', w=0.7, fh=0.42)
    with animated('anim_sway:a=x:d=18:p=2.6#yard', (MX, MH - 0.9, MZ + 0.85)):
        box((0.04, 0.34, 0.5), (MX, MH - 1.1, MZ + 0.62), 0x339cf2)
    # the rescue boat on its trailer, on the apron before the doors
    TX, TZ = 0.9, 1.2
    with plain_parts():
        box((0.08, 0.06, 1.6), (TX - 0.22, 0.4, TZ), 0x38383d)
        box((0.08, 0.06, 1.6), (TX + 0.22, 0.4, TZ), 0x38383d)
        for s in (-1, 1):
            beam((TX + s * 0.22, 0.4, TZ + 0.7), (TX, 0.4, TZ + 1.45), 0.06, 0x38383d)
        box((0.06, 0.3, 0.06), (TX, 0.27, TZ + 1.42), 0x38383d)                       # the jockey leg
    for s in (-1, 1):
        scenery_wheel(TX + s * 0.36, 0.31, TZ - 0.1, 0.17, 0.09)
        rod((TX + s * 0.25, 0.56, TZ - 0.65), (TX + s * 0.25, 0.56, TZ + 0.55), 0.12, 0xff7e44, segs=7)
    box((0.42, 0.06, 1.1), (TX, 0.47, TZ - 0.05), 0x4f5260)
    box((0.3, 0.2, 0.14), (TX, 0.58, TZ - 0.66), 0x38383d)
    # the patrol's feather flags along the sand, toward the cars coming and past
    for k, z in enumerate((-9.0, -6.6, -4.4, 5.0, 7.2)):
        pennant((1.4, 0.0, z), 2.1, ((red, yellow), (yellow, red))[k % 2], 'club%d' % k)
    join_still('club')
    on_a_rise()

@piece(1.0)
def surf_campers():
    # Riptide: the surfers' camp on the sand by the hook after the causeway:
    # camper vans at their real size, bigger than a racer and in colours no
    # racer wears, boards on their roofs, drawn up round a camp that shows
    # over the kerb: a sail of orange canvas stretched between three poles
    # for shade, the barbecue under it smoking thin, a fence of boards stood
    # in the sand, a signpost of painted arrows, bunting from the tall pole
    # to a palm and a hammock slung between that palm and the next, two
    # feather banners where the camp begins. No one about. +X is the road;
    # the camp runs along it (+Z). It stands outside a bend that closes on
    # its -Z end, so that end keeps back from the kerb.
    for (x, z, yw, lower, boards, pop) in ((-1.3, -5.6, -1.3, 'sky', (0xffc044, 0xff5040), True),
                                           (-1.6, -3.4, -1.7, 'tan', (0x339cf2,), False),
                                           (-1.4, 3.4, -1.9, 'lavender', (0xffc044,), False),
                                           (-0.9, 5.8, -1.5, 'cream', (0xff5040, 0x22c46e), False)):
        camper(x, z, yw, lower, boards=boards, pop=pop)
    # the shade sail: three poles, the canvas high toward the road
    A, B, C = (0.9, 2.3, -1.6), (0.7, 2.0, 1.7), (-1.7, 1.3, 0.1)
    with plain_parts():
        for (x, y, z) in (A, B, C):
            box((0.08, y, 0.08), (x, y / 2, z), 0x9a6a46)
    poly([A, B, C], [(0, 1, 2)], 0xff7e44)
    poly([(A[0], A[1] - 0.02, A[2]), ((A[0] + B[0]) / 2, (A[1] + B[1]) / 2 - 0.02, (A[2] + B[2]) / 2),
          ((A[0] + C[0]) / 2, (A[1] + C[1]) / 2 - 0.02, (A[2] + C[2]) / 2)], [(0, 1, 2)], 0xffc044)
    camper(-1.9, 11.8, -1.1, 'salmon', boards=(0xfff6eb, 0x339cf2), pop=True)         # one more, past the palms
    for k, z in enumerate((11.4, 13.4)):
        pennant((0.6, 0.0, z), 2.2, ((0xff7e44, 0xfff6eb), (0x339cf2, 0xffc044))[k], 'camp%d' % k)
    # the camp's gravel under the vans, and its track to the kerb where the
    # camp begins (+Z: the bend closes on the other end)
    gravel_yard(((-2.5, -0.3, -6.6, -2.4), (-2.6, -0.4, 2.4, 6.9), (-2.9, -0.9, 10.6, 12.9), (-2.2, -0.6, -2.6, 11.0),
                 (-0.8, 3.6, 5.0, 7.0)))
    cyl(0.14, 0.12, (-0.2, 0.34, 0.1), 0x38383d, segs=8)                               # the barbecue
    with plain_parts():
        for (dx, dz) in ((-0.08, -0.08), (0.08, -0.08), (0.0, 0.1)):
            box((0.03, 0.34, 0.03), (-0.2 + dx, 0.17, 0.1 + dz), 0x38383d)
    marker('anim_smoke:s=0.45', (-0.2, 0.5, 0.1))
    # the fence of boards along the road side
    cols = ((0xff5040, 0xfff6eb), (0x22c46e, 0xffc044), (0x339cf2, 0xfff6eb), (0xffc044, 0x339cf2),
            (0xfff6eb, 0xff5040), (0xff7e44, 0xfff6eb), (0x339cf2, 0xffc044))
    box((0.08, 0.07, 3.2), (0.6, 0.62, -4.4), 0x9a6a46)
    for z in (-5.9, -2.9):
        box((0.08, 0.66, 0.08), (0.6, 0.33, z), 0x9a6a46)
    for k, (col, st) in enumerate(cols):
        surfboard(0.54, -5.7 + k * 0.44, 0.0, col, st, lean=0.14, h=1.05 + 0.1 * (k % 3))
    # the signpost
    box((0.1, 2.3, 0.1), (1.0, 1.15, 3.4), 0x9a6a46)
    for k, (col, yw) in enumerate(((0xff5040, 0.3), (0xfff6eb, -0.5), (0x339cf2, 0.9), (0xffc044, -0.2))):
        box((0.07, 0.2, 0.8), (1.0, 2.1 - 0.3 * k, 3.4), col, yaw=yw)
    # the tall pole, the bunting to the palm, the hammock
    box((0.09, 2.6, 0.09), (0.6, 1.3, 4.8), 0xfff6eb)
    palm((0.2, 0, 7.6), h=2.9, lean=0.22, yaw=math.radians(250))
    palm((-0.9, 0, 9.4), h=2.5, lean=0.25, yaw=math.radians(60))
    line = sag((0.6, 2.55, 4.8), (0.0, 2.3, 7.4), 0.25, n=7)
    for i in range(6):
        beam(line[i], line[i + 1], 0.04, 0x9a6a46)
        mx, my, mz = [(p + q) / 2 for p, q in zip(line[i], line[i + 1])]
        poly([(mx, my, mz - 0.17), (mx, my, mz + 0.17), (mx, my - 0.3, mz)], [(0, 1, 2)],
             (0xff5040, 0xffc044, 0x339cf2, 0x22c46e)[i % 4])
    ham = sag((0.05, 0.75, 7.75), (-0.75, 0.75, 9.2), 0.3, n=5)
    for i in range(4):
        beam(ham[i], ham[i + 1], 0.26, 0xfde4c7, d=0.05)
    join_still('camp')
    on_a_rise()

@piece(1.0)
def surf_contest():
    # Riptide: the surf contest's site on the sand flat of the north run, a
    # line of it along the kerb for as long as the run is bare: feather
    # banners in the patrol's colours and the sea's, the judges' scaffold
    # tower with its canopy and its scoreboard to the road, two marquees,
    # the winners' podium and the contest's boards racked by it. The banners
    # stir and the tower's flags fly; no one is about (the heats are on the
    # water). +X is the road; it runs along it (+Z).
    red, yellow, blue, white, wood = 0xff5040, 0xffc044, 0x339cf2, 0xfff6eb, 0x9a7b55
    pairs = ((red, yellow), (blue, white), (0xff7e44, white), (yellow, blue), (red, white))
    for k, z in enumerate((-13.0, -10.4, -7.8, -5.2, 5.4, 8.0, 10.6, 13.2)):
        pennant((1.6, 0.0, z), 2.3 if k % 2 else 2.0, pairs[k % 5], 'run%d' % k)
    # the judges' tower: two decks of scaffold, a canopy, the scoreboard
    S, H1, H2 = 0.9, 1.3, 2.5
    with plain_parts():
        for sx in (-1, 1):
            for sz in (-1, 1):
                box((0.09, H2 + 0.9, 0.09), (-0.4 + sx * S, (H2 + 0.9) / 2, sz * S), 0x9aa1b4)
        for y0, y1 in ((0.1, H1), (H1, H2)):
            for sz in (-1, 1):
                beam((-0.4 - S, y0, sz * S), (-0.4 + S, y1, sz * S), 0.06, 0x9aa1b4)
            beam((-0.4 - S, y0, -S), (-0.4 - S, y1, S), 0.06, 0x9aa1b4)
    for y in (H1, H2):
        box((2 * S + 0.3, 0.1, 2 * S + 0.3), (-0.4, y, 0.0), wood)
    with plain_parts():
        for y in (H1, H2):
            box((0.06, 0.06, 2 * S + 0.3), (-0.4 + S + 0.12, y + 0.42, 0.0), white)
            for sz in (-1, 1):
                box((2 * S + 0.3, 0.06, 0.06), (-0.4, y + 0.42, sz * (S + 0.12)), white)
    box((0.08, 0.7, 2 * S + 0.2), (-0.4 + S + 0.14, H1 - 0.5, 0.0), yellow)            # the scoreboard
    for k, col in enumerate((red, blue, white, 0x22c46e)):
        box((0.06, 0.3, 0.3), (-0.4 + S + 0.2, H1 - 0.5, -0.66 + 0.44 * k), col)       # the heat's four colours
    for sz in (-1, 1):
        box((2 * S + 0.7, 0.07, 0.6 * (2 * S + 0.7)), (-0.4, H2 + 1.05, sz * (2 * S + 0.7) / 4), blue, pitch=-sz * 0.3)
    flag_on_pole((-0.4 - S, H2 + 0.9, -S), 0.8, (red, yellow), 'anim_sway:a=z:d=22:p=2.0#jt1', w=0.5, fh=0.3)
    flag_on_pole((-0.4 - S, H2 + 0.9, S), 0.8, (blue, white), 'anim_sway:a=z:d=22:p=2.3#jt2', w=0.5, fh=0.3)
    for i in range(7):                                                                 # its stair, up the back
        t = (i + 0.5) / 7
        box((0.5, 0.06, 0.24), (-0.4 - S - 0.3, H1 * t, S + 1.7 - 1.7 * t), wood)
    beam((-0.4 - S - 0.3, 0.0, S + 1.75), (-0.4 - S - 0.3, H1 - 0.06, S + 0.05), 0.12, wood)
    # the marquees, either side of the tower
    for k, (z, col) in enumerate(((-2.9, white), (3.2, yellow))):
        box((1.5, 0.95, 1.5), (-1.0, 0.475, z), white)
        box((0.06, 0.7, 0.9), (-0.24, 0.4, z), 0x4f5260)
        cyl(1.25, 0.75, (-1.0, 0.95, z), col, r2=0.06, segs=4, yaw=math.pi / 4)
        box((1.56, 0.12, 1.56), (-1.0, 0.95, z), (red, blue)[k])
    # the podium and the contest's boards
    for (dz, h, col) in ((0.0, 0.5, yellow), (-0.5, 0.36, white), (0.5, 0.26, white)):
        box((0.5, h, 0.5), (0.9, h / 2, -3.0 + dz), col)
    box((0.08, 0.07, 1.8), (0.9, 0.6, 3.2), wood)
    for z in (2.4, 4.0):
        box((0.08, 0.64, 0.08), (0.9, 0.32, z), wood)
    for k, (col, st) in enumerate(((red, white), (white, blue), (yellow, red), (blue, yellow))):
        surfboard(0.84, 2.6 + k * 0.4, 0.0, col, st, lean=0.15, h=1.0)
    join_still('contest')

@piece(1.0)
def beach_day():
    # Riptide: the bathers' beach on the flat past the contest, which was
    # bare sand to the Point: two rows of umbrellas over their loungers and
    # towels, a striped windbreak, a volleyball net with its ball, a row of
    # three changing huts with a flag and the ice-cream cart's parasol. No
    # one about but two sunbathers lying still (people at a car's size are
    # specks, and a still one standing reads uncanny). +X is the road; it
    # runs along it (+Z).
    red, yellow, blue, white, green = 0xff5040, 0xffc044, 0x339cf2, 0xfff6eb, 0x22c46e
    cols = ((red, white), (blue, white), (yellow, red), (green, white), (0xff7e44, white), (blue, yellow))
    k = 0
    for z in (-6.6, -4.2, -1.8):
        for x in (0.2, -2.0):
            cx, cz = x + 0.3 * math.sin(3.0 * k), z + 0.4 * math.cos(2.0 * k)
            umbrella((cx, 0, cz), 0.85, 1.25, cols[k % 6], gores=8)
            box((0.34, 0.12, 0.9), (cx + 0.45, 0.12, cz + 0.2), white, yaw=0.2 * k)          # a lounger
            box((0.34, 0.03, 0.9), (cx + 0.45, 0.2, cz + 0.2), cols[(k + 2) % 6][0], yaw=0.2 * k)
            box((0.4, 0.03, 0.8), (cx - 0.55, 0.02, cz - 0.3), cols[(k + 3) % 6][0], yaw=0.5 + 0.3 * k)   # a towel
            k += 1
    with square():
        figure((0.65, 0.22, -4.0), 1.57, shirt=red, legs=blue, pose='lie')
        figure((-1.55, 0.22, -6.4), 1.57, shirt=yellow, legs=0x38383d, pose='lie')
    for i in range(7):                                                           # the windbreak
        box((0.04, 0.8, 0.42), (1.3, 0.48, -0.9 + 0.42 * i), (blue, white)[i % 2])
    for i in range(4):
        box((0.06, 1.0, 0.06), (1.3, 0.5, -1.1 + 0.98 * i), 0x9a6a46)
    # the volleyball court: two posts, the net between, its tape, the ball
    for z in (3.0, 6.6):
        box((0.1, 1.5, 0.1), (-0.8, 0.75, z), white)
    rowed(box((0.04, 0.55, 3.6), (-0.8, 1.15, 4.8), 'lavender'), 2)
    box((0.06, 0.07, 3.6), (-0.8, 1.44, 4.8), white)
    sphere(0.17, (0.2, 0.17, 5.4), yellow, subdiv=2, flat=False)
    with plain_parts():                                                          # the court's lines, tape on the sand
        for (x, z, sx, sz) in ((-0.8, 3.0, 2.6, 0.06), (-0.8, 6.6, 2.6, 0.06), (0.5, 4.8, 0.06, 3.6), (-2.1, 4.8, 0.06, 3.6)):
            box((sx, 0.03, sz), (x, 0.015, z), blue)
    # the changing huts at the far end, and the ice-cream cart
    for i, c in enumerate((blue, yellow, red)):
        beach_hut(-1.6, 0.0, 8.4 + 1.25 * i, 0.0, c)
    flag_on_pole((-1.6, 0.0, 12.0), 2.2, (red, yellow), 'anim_sway:a=z:d=22:p=2.2#beach')
    box((0.6, 0.5, 0.9), (0.7, 0.45, 9.6), white)
    for z in (9.3, 9.9):
        scenery_wheel(1.02, 0.2, z, 0.2, 0.07)
    box((0.62, 0.1, 0.92), (0.7, 0.72, 9.6), 0xf378f0)
    umbrella((0.7, 0.7, 9.6), 0.7, 0.9, (0xf378f0, white), gores=8)
    join_still('beach')
    on_a_rise()

def riptide_dinghy(hull, sail, trim=0xfff6eb):
    """A sailing dinghy under sail, built bow to +X at the origin (a path
    faces its part's +X along its way): the hull a car and a half long, its
    gunwale, a tall mast, the mainsail on its boom and the jib, big enough
    that the sails read from the road."""
    box((1.6, 0.34, 0.6), (-0.1, 0.06, 0.0), hull)
    box((0.44, 0.34, 0.44), (0.72, 0.06, 0.0), hull, yaw=math.pi / 4)             # the bow
    box((1.64, 0.07, 0.64), (-0.1, 0.25, 0.0), trim)
    box((0.13, 4.0, 0.13), (0.26, 2.2, 0.0), trim)                                # the mast
    box((1.7, 0.1, 0.1), (-0.55, 0.64, 0.0), trim)                                # the boom
    poly([(0.18, 0.7, 0.0), (-1.4, 0.7, 0.0), (0.18, 4.1, 0.0)], [(0, 1, 2)], 0xfff6eb)        # the mainsail
    poly([(0.18, 1.9, 0.02), (-0.7, 1.9, 0.02), (0.18, 3.5, 0.02)], [(0, 1, 2)], sail)          # its colour panel
    poly([(0.34, 0.5, 0.0), (1.1, 0.3, 0.0), (0.34, 3.1, 0.0)], [(0, 1, 2)], sail)                # the jib

def riptide_water(L):
    """The sea's surface over the plain `L` off the causeway's centreline:
    the bay the shore lets in under the road lies kSeaSink down within
    kSinkHold of the road's support and eases back to the open sea's by
    kSinkOpen (TtpRenderer::seaSink; the support taken at the deck's edge
    and a little)."""
    t = min(1.0, max(0.0, (L - 10.7) / 18.0))
    return SEA - SEA_SUNK * (1.0 - t)

@piece(1.0)
def lagoon_fleet():
    # Riptide: the sailing club's race off the causeway, where the lap runs
    # out over the water: three dinghies, each its own colours, beating up
    # the course along the road in short tacks, rounding the far mark and
    # running back outside, round and round. What a racer sees is three
    # big sails crossing the water beside the road, turning at every tack;
    # the two orange marks stand at the course's ends. The water they sail
    # is the bay the causeway's shore lets down (riptide_water). +X is the
    # road (placed at yaw 180), the course along it.
    def road_x(z):
        return 17.871 + 0.1568 * z + 0.01446 * z * z       # the causeway's centreline here (scratch fit)
    course = [(8.0, 7.0), (3.5, 2.5), (8.5, -2.5), (3.5, -7.5), (8.5, -12.5), (4.0, -17.5), (8.0, -22.0),
              (2.0, -24.5), (-2.0, -16.0), (-2.5, -4.0), (-1.5, 4.5), (3.0, 9.5)]
    for k, (x, z) in enumerate(course):
        marker('path_race_%d' % k, (x, riptide_water(road_x(z) - x) - 0.04, z))
    for k, (hull, sail, o) in enumerate(((0xfff6eb, 0xff5040, 0.0), (0x339cf2, 0xffc044, 0.34),
                                         (0xff5040, 0x339cf2, 0.67))):
        x0, z0 = course[0]
        with animated('anim_path:c=race:p=48:f=1:o=%.2f+bob:h=0.05:p=%.1f#dinghy%d' % (o, 1.5 + 0.2 * k, k),
                      (0.0, 0.0, 0.0)):
            riptide_dinghy(hull, sail)
    with square():                                                    # the course's marks
        for (x, z) in ((5.0, -25.5), (2.0, 10.6)):
            y = riptide_water(road_x(z) - x)
            cyl(0.3, 0.7, (x, y - 0.2, z), 0xff7e44, r2=0.22, segs=8)
            box((0.1, 0.5, 0.1), (x, y + 0.7, z), 0xff7e44)
    join_still('marks')
    def stone_anchor():      # a mooring block on the bed: draped, so the race sails over the plain's level
        with plain_parts():
            box((0.3, 0.2, 0.3), (0.0, -0.6, 0.0), 'slate')
    draped('mooring', stone_anchor)

@piece(1.0)
def channel_beacon():
    # Riptide: the beacon marking the channel under the hop, where the
    # causeway bridges the gap between the sea and the lagoon: a stone foot
    # in the water, a stout post banded red and white, its red topmark and
    # lamp, as tall as the club's mast, against the sky as the road climbs
    # to the hop. It stands in the bay the shore lets down (riptide_water).
    rowed(cyl(0.8, 1.45, (0.0, -1.25, 0.0), 'grey', r2=0.7, segs=8), 15)
    box((1.2, 0.12, 1.2), (0.0, 0.26, 0.0), 0xfde4c7)
    for k in range(5):
        box((0.5, 1.0, 0.5), (0.0, 0.82 + k, 0.0), (0xff5040, 0xfff6eb)[k % 2])
    box((0.7, 0.12, 0.7), (0.0, 5.36, 0.0), 0x38383d)
    box((0.34, 0.36, 0.34), (0.0, 5.6, 0.0), 0xffc044)                      # the lamp
    cyl(0.42, 0.55, (0.0, 5.78, 0.0), 0xff5040, segs=8)                      # the topmark
    cyl(0.46, 0.55, (0.0, 6.33, 0.0), 0xff5040, r2=0.04, segs=8)
    for sz in (-1, 1):                                                     # the ladder's rails, to the water
        box((0.08, 4.6, 0.08), (0.33, 2.9, sz * 0.14), 0x38383d)
    join_still('beacon')
    on_a_rise()

@piece(1.0)
def coastguard_lookout():
    # Riptide: the coastguard's lookout on the Point's green flank over the
    # start straight, where the lap sets out and comes home: a white house
    # cut into the slope, its glazed lookout room on top under a red roof,
    # windows to the bay, and its signal mast beside it, the yard's flags
    # and the pennant at the head flying. +X is the road (placed at yaw 180
    # on the straight's left); the hill rises behind it, and the house runs
    # on under the slope.
    white, red, yellow, blue = 0xfff6eb, 0xff5040, 0xffc044, 0x339cf2
    W, D, H = 2.2, 2.6, 1.7
    box((W, H + 1.6, D), (0.0, (H - 1.6) / 2, 0.0), white)
    box((W + 0.12, 0.14, D + 0.12), (0.0, H, 0.0), 0xfde4c7)                 # the cornice
    for dz in (-0.7, 0.7):                                                 # windows to the road
        box((0.08, 0.5, 0.5), (W / 2 + 0.02, 0.95, dz), 0xfde4c7)
        box((0.08, 0.4, 0.4), (W / 2 + 0.05, 0.95, dz), 0x4f5260)
    box((0.08, 0.7, 0.5), (W / 2 + 0.02, 0.35, 0.0), 0xfde4c7)              # the door
    box((0.08, 0.62, 0.4), (W / 2 + 0.05, 0.32, 0.0), blue)
    # the lookout room: glazed all round, a white frame, the red roof
    LW, LD, LH = 1.5, 1.8, 0.9
    box((LW, 0.16, LD), (0.0, H + 0.15, 0.0), white)
    box((LW - 0.08, LH, LD - 0.08), (0.0, H + 0.23 + LH / 2, 0.0), 0x8ecae6)
    for (sx, sz) in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
        box((0.14, LH, 0.14), (sx * (LW / 2 - 0.05), H + 0.23 + LH / 2, sz * (LD / 2 - 0.05)), white)
    box((0.12, 0.1, LD), (LW / 2 - 0.02, H + 0.23 + LH * 0.55, 0.0), white)
    cyl(1.35, 0.7, (0.0, H + 0.23 + LH, 0.0), red, r2=0.08, segs=4, yaw=math.pi / 4)
    # the signal mast on the slope beside it, toward the cars coming (+Z)
    mx, mz = 0.6, 2.6
    box((0.36, 0.3, 0.36), (mx, 0.15, mz), 'grey')
    box((0.17, 6.0, 0.17), (mx, 3.0, mz), white)
    box((0.13, 0.13, 2.6), (mx, 4.6, mz), white)                           # the yard
    box((0.22, 0.22, 0.22), (mx, 6.06, mz), red)
    for k, (dz, cols) in enumerate(((-1.2, (red, yellow)), (1.2, (blue, white)))):
        with animated('anim_sway:a=x:d=18:p=%.1f#signal%d' % (1.9 + 0.35 * k, k), (mx, 4.6, mz + dz)):
            for i, c in enumerate(cols):
                box((0.06, 0.42, 0.5), (mx, 4.25 - 0.5 * i, mz + dz), c)
    with animated('anim_sway:a=x:d=22:p=1.6#pennant', (mx, 5.9, mz)):
        poly([(mx, 5.95, mz), (mx, 5.45, mz), (mx, 5.7, mz - 1.2)], [(0, 1, 2)], red)
    join_still('lookout')
    on_a_rise()

def riptide_kite(stake, at, span, colors, tag, p):
    """A big kite flown from a stake on the beach, its line a bar a
    racer can see (never a hairline), the kite's face across the piece
    (+X-Y plane, toward the road at +X), a tail of fat bows; kite, line
    and tail swing together about the stake on the wind."""
    sx, sy, sz = stake
    kx, ky, kz = at
    with animated('anim_sway:a=z:d=9:p=%.1f#kite%s' % (p, tag), (sx, sy, sz)):
        beam((sx, sy, sz), (kx, ky - 0.1, kz), 0.09, 0xfff6eb)
        h = span * 0.62
        # a diamond in two colours, its spars along its axes
        top, bot, lft, rgt = (kx, ky + h, kz), (kx, ky - h * 1.3, kz), (kx - span / 2, ky, kz), (kx + span / 2, ky, kz)
        poly([top, lft, (kx, ky, kz)], [(0, 1, 2)], colors[0])
        poly([top, (kx, ky, kz), rgt], [(0, 1, 2)], colors[1])
        poly([lft, bot, (kx, ky, kz)], [(0, 1, 2)], colors[1])
        poly([(kx, ky, kz), bot, rgt], [(0, 1, 2)], colors[0])
        beam(top, bot, 0.08, 0x38383d)
        beam(lft, rgt, 0.08, 0x38383d)
        tail = [(kx + 0.3 * math.sin(i * 1.3), ky - h * 1.3 - 0.45 * i, kz) for i in range(5)]
        for i in range(4):
            beam(tail[i], tail[i + 1], 0.08, 0xfff6eb)
            box((0.42, 0.14, 0.1), tail[i + 1], colors[i % 2], roll=0.3 * (1 if i % 2 else -1))

@piece(1.0)
def sailing_club():
    # Riptide: the sailing club on the bank outside the hook, where the
    # causeway points: the white boathouse with its blue doors to the road,
    # the club's mast with its yard and signal flags, three dinghies on
    # their trolleys on the hard before it with their sails up, rigged to
    # go down the slip to the race off the causeway, and two big kites the
    # club's school flies from a stake on the sand over the hook. +X is the
    # road (placed at yaw 180); the hook wraps round it.
    white, blue, red, yellow, wood = 0xfff6eb, 0x339cf2, 0xff5040, 0xffc044, 0x9a7b55
    # the boathouse: a long white shed under a grey roof, ridge along Z
    bx, bz, W, D, H = -2.4, 0.0, 2.6, 4.2, 1.7
    box((W, H + 0.6, D), (bx, (H - 0.6) / 2, bz), white)
    for k in range(4):                                                    # its weatherboards' laps
        box((W + 0.04, 0.05, D + 0.04), (bx, 0.35 + 0.35 * k, bz), 0xfde4c7)
    ang = math.atan2(0.9, W / 2)
    run = (W / 2 + 0.25) / math.cos(ang)
    for sx in (-1, 1):
        box((run, 0.12, D + 0.4), (bx + sx * (W / 2 + 0.25) / 2, H + 0.9 - 0.5 * (W / 2 + 0.25) * math.tan(ang) + 0.06, bz),
            0x4f5260, roll=sx * ang)
    for e in (-1, 1):
        poly([(bx - W / 2, H, bz + e * D / 2), (bx + W / 2, H, bz + e * D / 2), (bx, H + 0.9, bz + e * D / 2)], [(0, 1, 2)], white)
    for dz in (-1.0, 1.0):                                                # the two big doors to the road
        box((0.08, 1.3, 1.5), (bx + W / 2 + 0.02, 0.65, bz + dz), white)
        box((0.08, 1.2, 1.36), (bx + W / 2 + 0.05, 0.6, bz + dz), blue)
    box((0.1, 0.42, 2.6), (bx + W / 2 + 0.06, H - 0.12, bz), red)          # the club's red board over them
    # the club's mast: a white pole, its yard, a gaff, signal flags strung
    # from the yard's ends and the burgee at the head, all flying
    mx, mz = 0.2, 3.4
    box((0.3, 0.3, 0.3), (mx, 0.15, mz), 'grey')
    box((0.16, 5.0, 0.16), (mx, 2.5, mz), white)
    box((0.12, 0.12, 2.2), (mx, 3.9, mz), white)                         # the yard, across the road's view
    box((0.2, 0.2, 0.2), (mx, 5.06, mz), red)
    for k, (dz, cols) in enumerate(((-1.0, (red, yellow)), (1.0, (blue, white)))):
        with animated('anim_sway:a=x:d=18:p=%.1f#signal%d' % (1.8 + 0.4 * k, k), (mx, 3.9, mz + dz)):
            for i, c in enumerate(cols):
                box((0.06, 0.4, 0.46), (mx, 3.55 - 0.48 * i, mz + dz), c)
    with animated('anim_sway:a=x:d=22:p=1.7#burgee', (mx, 4.9, mz)):
        poly([(mx, 4.95, mz), (mx, 4.45, mz), (mx, 4.7, mz - 1.0)], [(0, 1, 2)], red)
    # the dinghies on their trolleys on the hard, bows to the road, sails up
    for k, (z, hull, sail) in enumerate(((-3.2, white, red), (-1.0, red, blue), (1.3, blue, yellow))):
        dx = 1.4
        for sz in (-0.24, 0.24):
            scenery_wheel(dx - 0.2, 0.14, z + sz, 0.14, 0.08)
        box((1.1, 0.08, 0.3), (dx - 0.2, 0.26, z), 0x38383d)
        before = set(bpy.context.scene.objects)
        riptide_dinghy(hull, sail)
        for o in bpy.context.scene.objects:
            if o not in before and o.parent is None:
                o.location += P(dx, 0.36, z)
    # the hard: concrete down from the boathouse to the slip at the hook's edge
    with plain_parts():
        rowed(box((4.2, 0.08, 8.6), (0.6, 0.04, 0.0), 'grey'), 6)
    # the kite school's stake and its two kites over the hook
    sx, sz = 2.8, -5.6
    box((0.32, 0.9, 0.32), (sx, 0.45, sz), wood)
    box((0.42, 0.14, 0.42), (sx, 0.9, sz), red)
    riptide_kite((sx, 0.85, sz), (sx + 1.4, 6.4, sz - 4.2), 1.9, (red, yellow), 'a', 3.1)
    riptide_kite((sx, 0.85, sz), (sx - 0.8, 5.2, sz - 6.8), 1.6, (blue, white), 'b', 3.7)
    join_still('club')

# ---- Driftwood: the strand the storm left ----

def drift_snag(x, z, h, lean, yaw, seed, limbs=4):
    """A tree the sea killed, still standing where the storm left it: the
    trunk leaning, its bare limbs up, bleached (build inside bleached()).
    Its foot runs on under the sand."""
    dx, dz = math.cos(yaw), math.sin(yaw)
    r0 = 0.07 * h + 0.07
    def trunk(t):
        return (x + dx * lean * h * t * t, h * t, z + dz * lean * h * t * t)
    pts = [(x, -0.4, z), trunk(0.4), trunk(0.75), trunk(1.0)]
    for i in range(3):
        rod(pts[i], pts[i + 1], r0 * (1 - 0.27 * i), 'tan', r2=r0 * (1 - 0.27 * (i + 1)), segs=6)
    for k in range(limbs):
        t = 0.42 + 0.5 * k / limbs
        bx, by, bz = trunk(t)
        a = yaw + 2.4 * k + seed
        reach = h * (0.36 - 0.05 * k)
        tip = (bx + math.cos(a) * reach * 0.8, by + reach * 0.7, bz + math.sin(a) * reach * 0.8)
        rod((bx, by, bz), tip, r0 * 0.36, 'cream' if k % 2 else 'tan', r2=0.035, segs=5)

def root_plate(at, r, face=1):
    """A thrown tree's root plate reared up on edge at `at` (its foot), `r`
    in radius, its face along Z (`face` -1 turns it to -Z): silver-brown
    wood ringed with its grain, the broken roots standing off its rim."""
    x, y, z = at
    cy = y + 0.9 * r
    cyl(r, 0.24, (x, cy, z - 0.12), 'tan', segs=10, axis='along')
    for rr, c in ((0.72 * r, 0x9a6a46), (0.46 * r, 'tan'), (0.22 * r, 0x9a6a46)):
        cyl(rr, 0.3 + (r - rr) * 0.05, (x, cy, z - 0.15), c, segs=10, axis='along')
    for a in (-0.9, -0.2, 0.5, 1.2, 1.9, 2.6, 3.4, 4.2):
        rod((x + 0.7 * r * math.cos(a), cy + 0.7 * r * math.sin(a), z),
            (x + 1.4 * r * math.cos(a), max(0.05, cy + 1.4 * r * math.sin(a) - 0.2), z + face * 0.5),
            0.1, 0x9a6a46, r2=0.035, segs=5)

@piece(1.0)
def driftwood_trunk():
    # Driftwood: a whole tree the storm brought in, where the strand line
    # begins: a forest giant lying along the verge, stripped and bleached,
    # its root plate reared up twice a car's height at one end, its broken
    # limbs standing up off the trunk, smaller logs washed up
    # against it and a dead tree still standing in the sand behind its roots. A
    # beachcomber sits on the trunk; the gull on the roots watches the cars
    # and hops off as one goes by. +X is the road.
    L = 9.0
    with bleached():
        spine = [(0.0, 1.05, -L / 2 + 0.3), (0.1, 0.8, -L / 4), (0.0, 0.52, 0), (-0.12, 0.34, L / 4), (0.05, 0.2, L / 2)]
        for i, rr in enumerate((0.42, 0.36, 0.3, 0.23)):
            rod(spine[i], spine[i + 1], rr, 'tan', r2=rr - 0.05, segs=7)
        root_plate((0.0, 0.0, -L / 2), 1.2)
        for (z, y, tip) in ((-1.6, 0.7, (0.9, 2.3, -1.0)), (0.6, 0.5, (-0.8, 2.0, 1.1)), (2.4, 0.36, (0.6, 1.5, 3.0))):
            rod((0.0, y, z), tip, 0.13, 'cream', r2=0.05, segs=6)
        rod((1.2, 0.12, -1.0), (1.9, 0.11, 1.4), 0.13, 'tan', r2=0.09)
        rod((-1.0, 0.1, 1.5), (-1.6, 0.09, 3.2), 0.1, 'cream', r2=0.07)
        rod((0.9, 0.16, -3.6), (-1.1, 0.5, -2.4), 0.15, 'cream', r2=0.1)               # one thrown across the trunk's foot
        drift_snag(-1.6, -3.2, 3.6, 0.2, 2.2, 1.0)
    figure((0.0, 0.84, -0.6), 0.0, shirt=0xff5040, legs=0xf2bf99, pose='sit')
    gull((0.0, 2.28, -L / 2), 0.0, 'anim_watch:r=24+hop:r=10:h=0.2#gull')
    join_still('trunk')

@piece(1.0)
def strand_line():
    # Driftwood: the line the storm tide left along the beach, from the
    # great trunk on: whole trees thrown up and bleached, piled on one
    # another, a root plate reared up out of each pile, the wrack between
    # them (weed, a lost float, a broken plank, a crate), and through it the
    # trees the sea killed where they stood, their bare limbs up over the
    # kerb: the low line alone lay hidden behind the road. It runs along Z,
    # two piles to the piece, their root plates at its two ends.
    wood, pale, dark = 'tan', 'cream', 'brown'
    def pile(m, phase):
        """One pile, `m` = -1 mirrors it along Z (its root plate to +Z)."""
        def x_at(z):
            return 0.6 * math.sin(z * 0.45 + phase)
        def at(x, y, z):
            return (x, y, m * z)
        with bleached():
            for (z0, z1, dx0, dx1, r, y0, y1, c) in ((-4.8, -1.0, 0.3, -0.4, 0.22, 0.22, 0.19, pale),
                                                    (-2.2, 2.4, -0.6, 0.2, 0.27, 0.27, 0.22, wood),
                                                    (-1.6, 1.4, 0.5, -0.1, 0.2, 0.62, 0.52, pale),
                                                    (-0.9, 0.9, -0.4, 0.5, 0.17, 0.95, 0.84, wood),   # piled on the others
                                                    (1.6, 4.9, 0.4, -0.3, 0.2, 0.2, 0.17, pale),
                                                    (3.0, 4.6, -0.7, 0.5, 0.13, 0.13, 0.13, dark)):
                rod(at(x_at(z0) + dx0, y0, z0), at(x_at(z1) + dx1, y1, z1), r, c, r2=r * 0.7, segs=7)
            rx = x_at(-2.3) - 0.6
            pz = -2.3 if m > 0 else -2.1
            root_plate(at(rx, 0.0, pz), 1.05, face=m)
            rod(at(rx, 0.95, pz + 0.1), at(rx + 0.5, 0.35, pz + 3.6), 0.34, 'tan', r2=0.25, segs=8)
        for z in (-4.0, -0.6, 0.9, 3.4):
            box((0.5, 0.04, 0.24), at(x_at(z) - 0.5, 0.02, z), 0x2f8f5b, yaw=-m * 0.6 * math.sin(z * 1.3))
        for z in (-3.0, 2.0):
            box((0.4, 0.04, 0.2), at(x_at(z) + 0.55, 0.02, z), 0x7a5a3a, yaw=-m * 0.8 * math.cos(z))
        # by one pile, a skiff the storm stove in (blocks of colour for
        # floats and slabs for nets were tried here and through the dead
        # trees, and read as nothing a racer could name)
        if m < 0:
            sx, _, sz = at(x_at(3.6) + 0.9, 0.0, 3.6)
            boat((sx, 0.1, sz), 0.7, 0xff5040, trim=0xfff6eb, L=1.7)
        box((0.12, 0.04, 0.75), at(x_at(3.2) + 0.7, 0.02, 3.2), 0x9a6a46, yaw=-m * 0.5)
        box((0.24, 0.2, 0.3), at(x_at(-3.8) - 0.6, 0.1, -3.8), 0xb06041, yaw=-m * 0.4)
    with moved(0.0, -4.9):
        pile(1, 0.0)
    with moved(0.35, 4.9):
        pile(-1, 1.3)
    with bleached():
        drift_snag(1.3, -8.4, 3.0, 0.25, 0.4, 3.0)
        drift_snag(-1.4, -1.2, 3.8, 0.15, 2.6, 4.0, limbs=5)
        drift_snag(1.1, 3.4, 2.6, 0.32, 5.2, 5.0, limbs=3)
        drift_snag(-0.9, 8.8, 3.3, 0.2, 1.4, 6.0)
    join_still('strand')

@piece(1.0)
def strand_snags():
    # Driftwood: the boneyard, on the east beach before the strand line
    # proper: a stand of trees the sea came in round and killed, bleached
    # where they stand, the tallest in the middle, two of them fallen at its
    # foot, and a gull on a limb who watches the cars. +X is the road.
    with bleached():
        for k, (x, z, h, lean, yw, limbs) in enumerate(((0.8, -7.0, 2.6, 0.3, 0.3, 3), (-0.9, -4.2, 3.4, 0.12, 2.2, 4),
                                                        (0.4, -0.6, 4.4, 0.1, 4.0, 5), (-1.6, 1.6, 2.9, 0.26, 1.2, 4),
                                                        (0.9, 4.4, 3.6, 0.18, 5.4, 4), (-0.6, 7.6, 2.4, 0.34, 3.0, 3))):
            drift_snag(x, z, h, lean, yw, 20.0 + k, limbs=limbs)
        rod((1.6, 0.2, -3.4), (-1.8, 0.24, -1.6), 0.22, 'tan', r2=0.15, segs=7)
        rod((1.4, 0.16, 2.0), (0.4, 0.2, 6.6), 0.18, 'cream', r2=0.1, segs=7)
        root_plate((1.5, 0.0, 1.9), 0.8)
    gull((0.4 + math.cos(4.0) * 0.44, 4.38, -0.6 + math.sin(4.0) * 0.44), 1.0, 'anim_watch:r=26#snag')   # on its top
    join_still('snags')

def dune_fence(name, seed, half, breaks):
    """A run of storm fence along a dune's foot, `half` either way along
    the road: slatted pickets on their rails, bleached, wandering, leaning,
    drifted half under in places and broken through at `breaks` (shares of
    its length), and the marram behind and before it. Marram grows in
    clumps with bare sand between (tussocks spread evenly the length of the
    fence read as planted at random): a few patches along the run, each a
    handful of tussocks of dry blades, pale green going to straw, knee high
    to a person; sea pinks or yellow at the foot of one patch in three.
    DRAPED whole: every slat and blade stands on the dune as it is drawn."""
    def build():
        # round 10: thin slats a stride apart read as hairlines at speed, so
        # thick posts twice a person's height, every couple of strides, and
        # two heavy rails between them
        n = int(2 * half / 1.5)
        with plain_parts(), bleached():
            prev = None
            for i in range(n + 1):
                f = i / n
                z = -half + 2 * half * f
                x = 0.9 * wobble(z, seed, 9.0)
                if any(abs(f - b) < 0.05 for b in breaks):
                    prev = None
                    continue
                sunk = 0.25 * max(0.0, wobble(z, seed + 1, 6.0))
                lean = 0.18 * wobble(z, seed + 2, 4.0)
                box((0.2, 1.5, 0.2), (x, 0.55 - sunk, z), ('brown', 'tan')[i % 2], roll=lean)
                if prev:
                    for y in (0.42, 0.95):
                        beam((prev[0] + 0.1, y - prev[1], prev[2]), (x + 0.1, y - sunk, z), 0.12, 'tan')
                prev = (x, sunk, z)
        with plain_parts():
            patches = int(half / 2.2)
            for p in range(patches):
                if frac(p * 0.618 + 0.37 * seed) < 0.3:              # bare sand where a patch might have been
                    continue
                pz = -half + 1.5 + (2 * half - 3.0) * (p + 0.5 * frac(p * 0.41 + seed)) / patches
                px = 0.9 * wobble(pz, seed, 9.0) + (1.0 if p % 2 else -1.1)
                for k in range(3 + p % 3):
                    a0 = 2.4 * k + p
                    d = 0.25 + 0.55 * frac(k * 0.37 + p * 0.21)
                    x, z = px + d * math.cos(a0), pz + 1.5 * d * math.sin(a0)
                    for j in range(5):                                # a tussock: blades fanned out of one foot
                        a = 1.26 * j + k
                        hgt = 0.55 + 0.3 * frac(k * 0.29 + j * 0.4 + p * 0.13)
                        o = beam((x + 0.05 * math.cos(a), -0.05, z + 0.05 * math.sin(a)),
                                 (x + 0.3 * math.cos(a), hgt, z + 0.3 * math.sin(a)), 0.1,
                                 ('green', 'cream', 'green', 'tan', 'green')[(j + k) % 5])
                        o['ramp'] = 0.15
                if p % 3 == 0:
                    for j in range(3):
                        fx, fz = px + 0.7 * math.cos(2.0 * j + p), pz + 0.9 * math.sin(2.0 * j + p)
                        box((0.03, 0.16, 0.03), (fx, 0.06, fz), 'green')
                        box((0.1, 0.08, 0.1), (fx, 0.17, fz), 'pink' if p % 2 else 'yellow')
    draped(name, build)

@piece(1.0)
def dune_fence_a():
    # Driftwood: the storm fence along the dune pass, where the lap ran
    # between bare faces of sand: it holds the dunes' feet, and the marram
    # the wardens planted behind it.
    dune_fence('fence', 3.0, 11.0, (0.28, 0.7))

@piece(1.0)
def dune_fence_b():
    # Driftwood: another length of it further up the pass, more of it under
    # the sand.
    dune_fence('fence', 8.0, 9.0, (0.5,))

def groyne(z, x0, x1, h0, h1, seed, gaps=()):
    """A timber groyne from x0 (by the road) down the beach to x1 in the
    surf: square posts a stride apart, `h0` tall at the road end falling to
    `h1`, dark with the wet, planked between on the side the drift comes
    from; a post in `gaps` has gone and its neighbours lean. Weed on the
    posts the tide covers."""
    n = int(abs(x1 - x0) / 0.95)
    with plain_parts():
        for i in range(n + 1):
            if i in gaps:
                continue
            t = i / n
            x, h = x0 + (x1 - x0) * t, h0 + (h1 - h0) * t + 0.12 * jitter(i, 1, seed)
            leanz = 0.22 * jitter(i, 2, seed) if (i - 1 in gaps or i + 1 in gaps) else 0.04 * jitter(i, 2, seed)
            box((0.24, h + 0.5, 0.24), (x, (h - 0.5) / 2, z), 0x8a6a46 if i % 3 else 0x9a7b55, pitch=leanz)
            if t > 0.55:
                box((0.28, 0.3, 0.28), (x, 0.18, z), WEED)
        runs, a = [], 0
        for i in range(n + 2):
            if i in gaps or i == n + 1:
                if i - 1 > a:
                    runs.append((a, i - 1))
                a = i + 1
        for (i0, i1) in runs:
            xa, xb = x0 + (x1 - x0) * i0 / n, x0 + (x1 - x0) * i1 / n
            ha, hb = h0 + (h1 - h0) * i0 / n, h0 + (h1 - h0) * i1 / n
            for f in (0.3, 0.68):
                beam((xa, ha * f, z - 0.16), (xb, hb * f, z - 0.16), 0.22, 'tan', d=0.07)

@piece(1.0)
def strand_groynes():
    # Driftwood: the groynes that hold this beach against the storms, where
    # the sea comes nearest the road: two rows of timber posts running from
    # the verge down into the surf, the far one broken through by the last
    # storm, the storm's logs heaped against their weather side and thrown
    # over them, a beacon post at each one's seaward end (one red, one
    # green, a gull on the nearer) and a dead tree standing between them. They start at
    # the kerb and point at the sea, so a racer reads them the whole way
    # past. +X is the road; the sea is -X.
    with bleached():
        # round 10: on out past the waterline into the surf, the posts
        # standing lower as the beach shelves, the sea breaking along them
        groyne(-5.5, 2.2, -19.0, 2.0, 0.9, 1.0)
        groyne(5.5, 2.4, -17.5, 1.8, 0.85, 2.0, gaps=(5, 6, 10))
    for (z, x, h, col) in ((-5.5, -19.9, 2.6, 0xff5040), (5.5, -18.4, 2.4, 0x22c46e)):   # the beacon posts, port and starboard
        box((0.3, h + 0.5, 0.3), (x, (h - 0.5) / 2, z), 0xfff6eb)
        box((0.32, 0.6, 0.32), (x, h * 0.55, z), col)
        box((0.7, 0.6, 0.7), (x, h + 0.25, z), col)
        box((0.5, 0.12, 0.5), (x, h - 0.2, z), 0xfff6eb)
    gull((-19.9, 3.08, -5.5), 2.0, 'anim_watch:r=26#beacon')
    for k, (x, z) in enumerate(((-15.0, -6.1), (-13.5, 4.9), (-18.5, -4.9))):
        with animated('anim_bob:h=0.3:p=%.1f:r=0.35#break%d' % (3.0 + 0.6 * k, k), (x, 0.0, z)):
            box((1.6, 0.3, 0.6), (x, SEA + 0.05, z), 0xfff6eb, yaw=0.2 * k)
    with bleached():
        # the storm's logs: heaped against the near groyne's weather side...
        for k, (x0, x1, y0, y1, dz, r) in enumerate(((1.6, -3.4, 0.25, 0.22, -0.75, 0.25), (0.4, -5.2, 0.2, 0.2, -1.35, 0.2),
                                                     (1.0, -2.6, 0.66, 0.6, -0.95, 0.2), (-2.2, -6.6, 0.24, 0.2, -0.7, 0.22),
                                                     (-1.0, -4.4, 0.84, 0.8, -0.62, 0.16))):
            rod((x0, y0, -5.5 + dz), (x1, y1, -5.5 + dz - 0.3 * jitter(k, 1, 9.0)), r, ('tan', 'cream')[k % 2],
                r2=r * 0.75, segs=7)
        rod((-0.6, 0.1, -7.6), (-2.4, 2.25, -5.3), 0.2, 'tan', r2=0.13, segs=7)     # one thrown up over it
        # ...and through the far one's breach
        rod((-2.0, 0.2, 3.4), (-4.4, 0.24, 7.6), 0.26, 'tan', r2=0.2, segs=7)
        rod((-3.6, 0.5, 4.4), (-1.2, 0.2, 7.0), 0.18, 'cream', r2=0.12, segs=7)
        rod((0.8, 0.16, 4.2), (1.8, 0.14, 1.0), 0.16, 'cream', r2=0.1, segs=7)
        root_plate((-4.6, 0.0, 7.9), 0.9, face=-1)
        drift_snag(0.2, 0.2, 3.9, 0.18, 3.6, 7.0, limbs=5)
        drift_snag(-4.4, -1.4, 2.7, 0.3, 1.0, 8.0, limbs=3)
    join_still('groynes')

@piece(1.0)
def driftwood_forts():
    # Driftwood: the fort the beachcombers build from the storm's logs, on
    # the open sand outside the strand hairpin where the road points at it.
    # Every part stands clear of the next (logs thrown through one another
    # and a teepee stood in the heap read as parts clipping): the storm's
    # big logs stacked three, two and one along the road, a tall teepee of
    # poles on the sand at one end of the stack with a red flag at its top
    # and a blue tarpaulin on its weather side, a smaller teepee at the
    # other end, a string of round floats from one to the other, and two
    # dead trees standing behind, well back from the stack. Static but for
    # the flag; no one about. The road is on -X here (tracks.js places it
    # unturned on the track's left); it runs along it (+Z).
    DRIFT, END = 0x9a6a46, 'tan'
    def teepee(tx, tz, TH, R, n, seed, tarp=None):
        feet = []
        for i in range(n):
            a = i / n * 2 * math.pi + seed
            foot = (tx + math.cos(a) * R, -0.3, tz + math.sin(a) * R)
            tip = (tx - math.cos(a) * 0.1, TH + 0.1 * (i % 3), tz - math.sin(a) * 0.1)
            cut = tuple(f + (t - f) * 0.9 for f, t in zip(foot, tip))
            rod(foot, cut, 0.08, 'tan' if i % 3 == 0 else DRIFT, r2=0.055, segs=5)
            rod(cut, tip, 0.055, END, r2=0.045, segs=5)
            feet.append(foot)
        if tarp is not None:
            top = (tx, TH - 0.15, tz)
            for i in tarp:                              # cloth laid on the poles, from the sand to near the top
                a, b = feet[i], feet[(i + 1) % n]
                out = lambda p: (tx + (p[0] - tx) * 1.06, 0.0, tz + (p[2] - tz) * 1.06)
                poly([top, out(a), out(b)], [(0, 1, 2)], 0x339cf2)
    with bleached():
        # the stack: three on the sand, two in their laps, one on top
        for k, (x, y, z0, z1, r) in enumerate(((-2.3, 0.3, -2.7, 2.5, 0.3), (-1.68, 0.29, -2.4, 2.8, 0.29),
                                               (-1.08, 0.3, -2.9, 2.3, 0.3), (-1.99, 0.8, -2.2, 2.3, 0.27),
                                               (-1.38, 0.8, -2.5, 2.0, 0.27), (-1.68, 1.27, -1.9, 1.9, 0.25))):
            rod((x, y, z0), (x, y, z1), r, DRIFT, r2=r * 0.92, segs=8)
            for (ez, sgn) in ((z0, -1), (z1, 1)):
                rod((x, y, ez), (x, y, ez + sgn * 0.04), r * 0.86, END, segs=8)
        teepee(-1.4, 4.9, 2.1, 1.0, 11, 0.2, tarp=(3, 4, 5))
        teepee(-1.2, -4.7, 1.4, 0.75, 9, 0.9)
        box((0.07, 0.8, 0.07), (-1.4, 2.55, 4.9), END)
    with animated('anim_sway:a=y:d=20:p=2.4#fort', (-1.4, 2.9, 4.9)):
        poly([(-1.4, 2.93, 4.9), (-0.8, 2.78, 4.9), (-1.4, 2.6, 4.9)], [(0, 1, 2)], 0xff5040)
    # floats strung from the tall teepee to the small one over the stack:
    # round ones, on a rope, which is what a float looks like
    line = sag((-1.4, 2.15, 4.9), (-1.2, 1.5, -4.7), 0.25, n=9)
    for i in range(8):
        beam(line[i], line[i + 1], 0.04, 0x9a6a46)
        if 0 < i < 7:
            mx, my, mz = [(p + q) / 2 for p, q in zip(line[i], line[i + 1])]
            sphere(0.13, (mx, my - 0.13, mz), (0xff7e44, 0xfff6eb)[i % 2], subdiv=2, flat=False)
    with bleached():
        drift_snag(2.2, -3.4, 3.4, 0.22, 2.9, 9.0)
        drift_snag(2.6, 3.2, 2.6, 0.3, 0.8, 10.0, limbs=3)
    join_still('forts')
    # a cold fire ring before the stack, on the sand as it lies: the piece
    # stands on the land as it is and levels nothing
    def ring():
        with plain_parts():
            for i in range(7):
                a = i / 7 * 2 * math.pi
                box((0.12, 0.08, 0.1), (0.5 + 0.28 * math.cos(a), 0.04, 0.0 + 0.28 * math.sin(a)), 'grey', yaw=-a)
    draped('ring', ring)

# The dune at the end of Driftwood's pass that the lighthouse stands on:
# sand on its faces, marram over its back (round 10, r10-drive-through).
DUNE_BEDS = ((-0.6, 0.8, 'cream', -0.85), (0.8, 2.2, 'sage', -0.85), (2.2, 3.6, 'sage', -0.85),
             (3.6, 5.4, 'sage', -0.85), (5.4, 7.2, 'sage', -0.85), (7.2, 8.4, 'sage', -0.85),
             (8.4, 10.5, 'sage', -0.85))

@piece(1.0)
def lighthouse_dune():
    # Driftwood: the great dune at the end of the pass, which the road goes
    # through in a tunnel and the lighthouse stands on (tracks.js sets it on
    # the dune's seaward shoulder, a flat of marram at 6.2): the pass drives
    # straight at the light on its dune and into the dune's dark mouth, and
    # comes out at the point. The tunnel's walls are the sand cut back to
    # stone, its mouths framed in stone with a lintel well over every car's
    # roof and chase camera. Placed on the road's centreline: +X is its left,
    # the sea's side.
    with plain_parts():
        M = massif_height(((0.0, 0.0, 9.6, 12.0, 16.0, math.pi / 2, 0.6, 14.0),   # the dune's back, across the road
                           (10.5, 0.5, 9.0, 9.0, 7.5, 0.2, 0.25, 5.0),            # its seaward shoulder, the light's
                           (-14.0, -1.0, 7.0, 9.0, 8.0, -0.4, 0.8, 6.0)),          # its inland flank
                          rough=0.3, seed=1.9, warp=1.0)
        tunnel = strata_massif(M, -32.0, 30.0, -18.0, 18.0, DUNE_BEDS, corridor=(5.6, 3.6), step=2.6, tol=0.4)
        for o in bpy.context.scene.objects:
            if o.type == 'MESH' and o.get('swatch') and o.get('row') is None:
                if o['swatch'] == 'brown':                          # the tunnel's lining, out of the sun
                    o['swatch'] = 'grey'
                    rowed(o, 26)
                else:
                    rowed(o, {'cream': 31, 'sage': 3}.get(o['swatch'], 16))
        print('PROBE dune tunnel', tunnel, [(round(x), round(M(x, 0.5), 2)) for x in (6, 8, 10, 11, 12, 14)])
        if tunnel:
            for z, sgn in ((tunnel[0] - 0.3, -1), (tunnel[1] + 0.3, 1)):   # the portals, stone, a lintel over
                for sx in (-1, 1):
                    box((1.0, 3.9, 1.0), (sx * 5.3, 1.75, z), 'grey')
                    box((1.2, 0.3, 1.2), (sx * 5.3, 0.05, z), 'slate')
                box((12.0, 0.75, 1.1), (0.0, 3.95, z), 'grey')
                box((1.1, 0.95, 1.2), (0.0, 3.95, z + 0.06 * sgn), 'lavender')   # the keystone
                box((12.6, 0.2, 1.3), (0.0, 4.4, z), 'lavender')
    def foot():
        with plain_parts():
            box((0.3, 0.3, 0.3), (-20.0, -0.4, 0.0), 'grey')
    draped('foot', foot)

def drift_boat_hut(cz, L, W, H, door, seed):
    """An old beach boat turned keel up and roofed into a store, as the
    fishers of a storm coast keep their gear: its tarred hull, laps of
    planking down it, the stern sawn off square and walled with planks, a
    door in it to the road (+X), a stove pipe through the keel. The hull
    runs along the road (+Z), its stern end at -Z."""
    rows = []
    n, m = 9, 7
    for i in range(n):
        t = -1.0 + 2.0 * i / (n - 1)
        w = 0.5 * W * max(0.05, 1.0 - 0.9 * max(0.0, t) ** 2.5 - 0.15 * min(0.0, t) ** 2)
        h = H * (1.0 - 0.18 * t * t)
        rows.append([(w * math.cos(math.pi * j / (m - 1)), h * math.sin(math.pi * j / (m - 1)) - 0.08, cz + 0.5 * L * t)
                     for j in range(m)])
    for o in sheet(rows, lambda i, j, nn: 'brown', 'hull'):
        rowed(o, 24)
    for j in (1, 3):                                                       # the laps of planking
        beam((0.5 * W * math.cos(math.pi * j / 6) + 0.03 * (1 if j < 3 else -1), H * math.sin(math.pi * j / 6),
              cz - 0.5 * L), (0.2 * W * math.cos(math.pi * j / 6), 0.9 * H * math.sin(math.pi * j / 6), cz + 0.42 * L),
             0.08, 'tan')
    box((0.16, 0.14, L * 0.92), (0.0, H - 0.02, cz - 0.03 * L), 'tan')    # the keel, up top
    zs = cz - 0.5 * L
    box((W * 0.95, H * 0.95, 0.12), (0.0, H * 0.45, zs), 0xfde4c7)         # the sawn-off stern, walled
    box((0.12, H * 0.62, W * 0.34), (0.5 * W * 0.55, H * 0.31, zs + 0.2), door)   # its door to the road
    box((0.5, 0.9, 0.14), (0.25 * W, H * 0.33, zs - 0.03), door)
    cyl(0.1, 0.9, (-0.1, H - 0.1, cz + 0.15 * L), 'grey', segs=6, stem=True)   # the stove pipe
    box((0.28, 0.08, 0.28), (-0.1, H + 0.82, cz + 0.15 * L), 'slate')

@piece(1.0)
def boat_huts():
    # Driftwood: where the pass leaves the beach, the fishers' stores in the
    # marram: three old beach boats hauled up and turned keel up into huts,
    # their sterns walled and doored to the road, stove pipes through the
    # keels; their gear between them, creels stacked, a capstan,
    # nets hung over a frame of thick spars. +X is the road; the row runs
    # along it (+Z).
    for k, (z, L, W, H, door) in enumerate(((-6.5, 4.6, 2.0, 1.5, 0xcf534f), (0.0, 5.2, 2.2, 1.7, 0x339cf2),
                                            (6.4, 4.2, 1.9, 1.4, 0x61cb8b))):
        drift_boat_hut(z, L, W, H, door, k)
    for (x, y, z) in ((1.4, 0.0, -3.4), (1.4, 0.0, -2.9), (1.4, 0.32, -3.15), (1.6, 0.0, 3.2)):
        crab_pot((x, y, z), 0.0)
    cyl(0.32, 0.7, (1.5, 0.0, 9.4), 0x8a6a46, segs=8, stem=True)            # the capstan
    box((1.6, 0.14, 0.14), (1.5, 0.62, 9.4), 'tan')
    with bleached():                                                        # the net frame
        for z in (-9.6, -8.0):
            box((0.16, 2.2, 0.16), (0.9, 1.1, z), 'tan')
        box((0.14, 0.14, 1.9), (0.9, 2.15, -8.8), 'tan')
    for i, c in enumerate(('green', 'sky', 'green')):
        box((0.06, 1.3, 0.5), (0.9, 1.45, -9.4 + 0.55 * i), c)
    join_still('huts')

@piece(1.0)
def drift_coble():
    # Driftwood: a beach boat under its brown lugsail working in and out
    # past the groynes' ends (placed on the groynes' spot, on the road's
    # centreline): the sea's side is +X here.
    for i in range(14):
        t = i / 14 * 2 * math.pi
        marker('path_coble_%d' % i, (13.0 + 3.0 * math.sin(t), 0.0, 11.0 * math.cos(t)))
    beach_sailing_boat('coble', 30.0, 0xcf534f, 0xb06041)

@piece(1.0)
def smokehouse():
    # Driftwood: the fishers' smokehouse where the start straight bends away
    # (the straight points at it): a tall tarred timber house, its roof
    # vented along the ridge, a lean-to of split
    # logs for the fires; the beach boat hauled up beside it on its skids,
    # the capstan that winched it up the shingle, fish boxes stacked. At a
    # building's real size beside a car. +X is the road; along it (+Z).
    tar, trim = 0x8d5741, 0xfde4c7
    box((2.6, 3.4, 3.2), (-1.8, 1.4, 0.0), 'brown')                          # the house, its feet in the sand
    for y in (1.0, 2.0):                                                     # the boards' laps
        box((2.66, 0.07, 3.26), (-1.8, y, 0.0), 'tan')
    for sz in (-1, 1):                                                       # its roof, steep
        box((1.75, 0.14, 3.6), (-1.8 + sz * 0.72, 3.62, 0.0), 'grey', roll=sz * 0.95)
    box((0.9, 0.5, 3.0), (-1.8, 4.35, 0.0), tar)                              # the louvred vent along the ridge
    box((1.1, 0.12, 3.2), (-1.8, 4.66, 0.0), 'grey')
    for k in range(4):
        box((0.95, 0.08, 0.1), (-1.8, 4.3, -1.2 + 0.8 * k), 'slate')
    box((0.07, 1.3, 1.0), (-0.47, 0.65, -0.6), trim)                         # the door to the road
    box((0.07, 1.2, 0.86), (-0.45, 0.6, -0.6), 0xcf534f)
    box((0.07, 0.5, 0.6), (-0.47, 2.2, 0.8), 'slate')
    # the log store against its end
    for k in range(3):
        for j in range(3 - k):
            cyl(0.2, 1.4, (-2.6 + 0.42 * j + 0.21 * k, 0.2 + 0.36 * k, 1.9), 'tan', segs=7, axis='along', stem=True)
    box((1.6, 0.1, 1.2), (-2.1, 1.35, 2.25), 'grey', pitch=0.2)
    # the beach boat hauled up on its skids, bow to the sea (-X), its mast
    BX, BZ = -1.2, -4.4
    box((3.0, 0.7, 1.2), (BX, 0.55, BZ), 0x339cf2)
    box((0.85, 0.7, 0.85), (BX - 1.7, 0.55, BZ), 0x339cf2, yaw=math.pi / 4)
    box((3.1, 0.16, 1.3), (BX, 0.95, BZ), trim)
    box((0.14, 3.0, 0.14), (BX - 0.3, 2.3, BZ), 0x8a6a46)
    for dz in (-0.4, 0.4):
        box((3.6, 0.18, 0.18), (BX, 0.12, BZ + dz), 0x8a6a46)
    cyl(0.36, 0.8, (1.0, 0.0, BZ - 0.2), 0x8a6a46, segs=8, stem=True)        # the capstan
    box((1.9, 0.16, 0.16), (1.0, 0.7, BZ - 0.2), 'tan')
    beam((0.75, 0.4, BZ - 0.2), (BX + 1.5, 0.6, BZ), 0.09, 0x38383d)          # its cable to the bow ring
    for (x, y, z) in ((0.2, 0.0, 2.1), (0.2, 0.32, 2.1), (0.2, 0.0, 2.75), (0.6, 0.0, 2.4)):
        box((0.7, 0.3, 0.5), (x, y + 0.15, z), (0xcf534f, 0x339cf2, 0xfde4c7, 0xcf534f)[int(z * 3 + y * 5) % 4])
    join_still('smokehouse')

@piece(1.0)
def point_wrack():
    # Driftwood: what the storms pile on the point under the lighthouse,
    # where the road turns back from the sea: a great heap of driftwood, whole
    # trunks thrown one over another and two root plates reared up on edge
    # twice a car's height, bleached, a dead tree standing out of it. It
    # faces the road's exit from the tunnel. +X is the road.
    with bleached():
        for k, (a, b, r) in enumerate((((-0.5, 0.3, -4.0), (-1.5, 0.35, 3.8), 0.36),
                                       ((0.5, 0.25, -2.5), (-2.6, 0.9, 2.6), 0.3),
                                       ((-2.8, 0.3, -3.2), (-0.4, 1.0, 1.6), 0.28),
                                       ((-1.2, 0.95, -3.0), (-2.2, 0.8, 2.2), 0.26),
                                       ((-0.2, 1.0, -1.6), (-2.6, 1.15, 1.0), 0.22),
                                       ((0.9, 0.2, 0.6), (-1.0, 0.3, 4.6), 0.3))):
            rod(a, b, r, ('tan', 'cream')[k % 2], r2=r * 0.75, segs=7)
        root_plate((-1.6, 0.0, -4.2), 1.5, face=-1)
        root_plate((-2.4, 0.0, 3.9), 1.2, face=1)
        drift_snag(-3.4, 0.4, 4.2, 0.2, 2.4, 13.0, limbs=4)
    join_still('wrack')

# ====================================================================================
# SNOW
# ====================================================================================

def snowy(o, k=0.3):
    """Lying snow: a third of the ramp, so a drift at the foot of a tall piece
    stays snow-white instead of greying to stone (shade())."""
    o['ramp'] = k
    return o

def mound(peak, cx, cz, rx0, rx1, rz, color=0xeef4f9, rings=6, segs=18, sink=0.4, shape=1.6, jitter=0.0):
    """A hill on an oval foot round its summit (cx, cz): `rx1` out toward +X
    (the road), `rx0` behind, `rz` along. A polar mesh, so the hill is whole
    on every side, and its rim sinks `sink` under the ground so no edge stands
    in the air or fights the snow. Returns its height h(x, z) for what stands
    on it (the jitter, a faceted roughness on the inner rings, is left out)."""
    def R(dx, dz):
        a = math.atan2(dz, dx)
        rx = rx1 if math.cos(a) > 0 else rx0
        return 1.0 / math.sqrt((math.cos(a) / rx) ** 2 + (math.sin(a) / rz) ** 2)
    def g(t):
        return math.cos(min(t, 1.0) * math.pi / 2) ** shape
    def h(x, z):
        dx, dz = x - cx, z - cz
        t = math.hypot(dx, dz) / R(dx, dz)
        return (peak + sink) * g(t) - sink
    verts = [P(cx, peak, cz)]
    for i in range(1, rings + 1):
        t = i / rings
        for j in range(segs):
            a = j / segs * 2 * math.pi + (0.5 / segs * 2 * math.pi if i % 2 else 0.0)
            dx, dz = math.cos(a), math.sin(a)
            r = R(dx, dz) * t
            y = (peak + sink) * g(t) - sink
            if i < rings:
                y += jitter * (1 - t) * math.sin(j * 2.7 + i * 1.3)
            verts.append(P(cx + dx * r, y, cz + dz * r))
    faces = [(0, 1 + j, 1 + (j + 1) % segs) for j in range(segs)]
    for i in range(rings - 1):
        a0, b0 = 1 + i * segs, 1 + (i + 1) * segs
        for j in range(segs):
            k = (j + 1) % segs
            faces.append((a0 + j, b0 + j, b0 + k, a0 + k))
    me = bpy.data.meshes.new('mound')
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    if me.polygons[0].normal.z < 0:
        for p in me.polygons:
            p.flip()
    o = bpy.data.objects.new('mound', me)
    bpy.context.scene.collection.objects.link(o)
    snowy(paint(o, color), 0.45)
    return h

# The ground a piece was modelled standing on, when it is TERRAIN rather than
# part of the model: public/shared/tracks.js SET_GROUND, handed over by
# scripts/gen-set-prototypes.mjs (TTP_SET_GROUND). The renderer lays the same
# numbers as the track's ground wherever the piece stands, so what is built on
# it here — towers, pines, rocks — stands on the terrain in the game. In world
# units there; this frame is the build's, which the export grows by GROW.
SET_GROUND = json.loads(os.environ.get('TTP_SET_GROUND', '{}'))

def set_ground(name):
    """height(x, z) of the piece's SET_GROUND in the build frame: its mounds
    and fans, as the renderer's terrain has them (TtpRenderer::landforms;
    tracks.js setGroundY is the JS copy set-check reads): the highest mound, the fans on it,
    and the plain (0) past them. A mound's summit is `h` tall reaching `r`
    toward +X, `r1` behind and `rz` along, its flank cos(t*pi/2)^shape; a fan
    is a ridge's capsule, `len` along its +Z, `r`/`h` at the -Z end and
    `r1`/`h1` at the +Z end, a flat crest `top`; `yaw` turns either."""
    forms = [f for f in SET_GROUND.get('set-' + name, []) if f['kind'] in ('mound', 'fan')]
    if not forms:
        raise SystemExit('set-%s has no SET_GROUND mound: run it through scripts/gen-set-prototypes.mjs' % name)
    k = GROW[name]
    def h(x, z):
        best, fans = 0.0, 0.0                     # a fan lies ON the mounds: its rise adds
        for f in forms:
            a = math.radians(f.get('yaw', 0.0))
            c, s = math.cos(a), math.sin(a)
            lx = x * k * c - z * k * s - f.get('x', 0.0)
            lz = x * k * s + z * k * c - f.get('z', 0.0)
            if f['kind'] == 'mound':
                t = math.hypot(lx / (f['r'] if lx > 0 else f['r1']), lz / f['rz'])
                if t < 1.0:
                    best = max(best, f['h'] * math.cos(t * math.pi / 2) ** f.get('shape', 1.0))
                continue
            half = f.get('len', 0.0) / 2
            cz = min(half, max(-half, lz))
            at = (cz + half) / f['len'] if f.get('len') else 0.0
            r0, r1 = f['r'], f.get('r1', f['r'])
            t = math.hypot(lx, lz - cz) / (r0 + (r1 - r0) * at)
            if t >= 1.0:
                continue
            top = f.get('top', 0.0)
            q = 0.0 if t <= top else min(1.0, (t - top) / (1 - top))
            h0, h1 = f['h'], f.get('h1', f['h'])
            fans += (h0 + (h1 - h0) * at) * (1 - q * q * (3 - 2 * q))
        return (best + fans) / k
    return h

def group(objs, name):
    """Export `objs` as ONE node called `name` (joined after they are shaded
    and chamfered, so each part keeps its own swatch): a part the renderer moves
    as a whole, like the lift's chairs (`anim_` nodes)."""
    for o in objs:
        o['group'] = name
    return objs

def join_still(name):
    """Every part of the piece that stands still as ONE node `name`. The
    per-placement bake cuts a piece by whole part into 8 u tiles, a draw
    each, so a piece spread wide over the sand (a reef run, a dune with its
    boardwalk) would cost a dozen draws a placement; as one part it costs
    one wherever it stands. Call it last, after the moving parts are built."""
    return group([o for o in bpy.context.scene.objects
                  if o.type == 'MESH' and o.get('anim') is None], name)

def draped(name, build):
    """Run `build` and make what it made ONE part named `drape_<name>`: the
    renderer lays each vertex on the ground as it DRAWS it (a 9 u grid's
    chords, a hand's breadth or more off the curve on a slope), so small
    things on a piece's own ground are built from y = 0 as if on the plain
    and land on the drawn slope instead of floating off it or sinking in.
    A moving part built inside keeps its own node (a grazing head: give it
    the `drape` verb so it lands with the body)."""
    before = set(bpy.context.scene.objects)
    build()
    return group([o for o in bpy.context.scene.objects
                  if o not in before and o.type == 'MESH' and o.get('anim') is None], 'drape_' + name)

def turned(cx, cz, yaw, lx, lz):
    """A point (lx, lz) in a frame at (cx, cz) turned by `yaw` (box()'s sense:
    its +Z runs along (sin yaw, cos yaw))."""
    c, s = math.cos(yaw), math.sin(yaw)
    return cx + lx * c + lz * s, cz - lx * s + lz * c

# ---- the snow world at its real size -------------------------------------------
# A car is 0.9 long, and the ambient pines stand 2 to 4 tall: a unit is some
# four or five metres. Everything below is built at the size the real thing
# would be next to a real car, a little chunkier at most (a person or a
# penguin under half a unit, a cabin two or three across), so the pieces are
# authored in world units and grow 1. What is big in life (the ski mountain,
# the avalanche slopes, the glacier, the lake) is the track's terrain.

def flag_across(at, h, color, wave, w=0.8, fh=0.5, pole=0xfff6eb):
    """A pole `h` tall and its flag flying ACROSS the piece (+Z), so a piece
    facing the road (+X) shows the road the cloth, not its edge; `wave` flaps
    it about its own normal (x), hinged at the top of the pole."""
    x, y, z = at
    box((0.08, h, 0.08), (x, y + h / 2, z), pole)
    with animated(wave, (x, y + h, z)):
        box((0.06, fh, w * 0.55), (x, y + h - fh / 2 - 0.04, z + w * 0.27 + 0.04), color)
        box((0.06, fh * 0.9, w * 0.5), (x + 0.06, y + h - fh / 2 - 0.08, z + w * 0.76), color, yaw=0.3)

def snow_person(x, y, z, coat, hat, yaw=0.0):
    """Someone standing, facing +X turned by `yaw`, at a person's size beside a
    car (0.48 tall): boots and legs, a coat, a head in a hat."""
    c, s = math.cos(yaw), math.sin(yaw)
    def at(dx, dy):
        return (x + dx * c, y + dy, z - dx * s)
    box((0.1, 0.18, 0.14), at(0, 0.09), 0x38383d, yaw=yaw)
    box((0.13, 0.17, 0.18), at(0, 0.265), coat, yaw=yaw)
    box((0.09, 0.09, 0.09), at(0.01, 0.395), 0xf2bf99, yaw=yaw)
    box((0.1, 0.06, 0.1), at(0.0, 0.465), hat, yaw=yaw)

def seated(x, y, z, coat, hat, yaw=0.0):
    """Someone sitting (on a chair, a bucket), facing +X turned by `yaw`; `y`
    is the seat."""
    c, s = math.cos(yaw), math.sin(yaw)
    def at(dx, dy):
        return (x + dx * c, y + dy, z - dx * s)
    box((0.2, 0.07, 0.14), at(0.07, 0.035), 0x38383d, yaw=yaw)       # thighs
    box((0.13, 0.17, 0.18), at(-0.02, 0.15), coat, yaw=yaw)
    box((0.09, 0.09, 0.09), at(-0.01, 0.28), 0xf2bf99, yaw=yaw)
    box((0.1, 0.06, 0.1), at(-0.02, 0.35), hat, yaw=yaw)

def skier(x, y, z, coat, hat):
    """A skier running toward +X, crouched over the skis, at a person's size:
    the skis, bent legs, a coat leaning in, a head and hat. Joined into one
    moving part by its caller."""
    box((0.5, 0.06, 0.13), (x + 0.03, y + 0.03, z), 0x2a2735)                 # the pair of skis
    box((0.1, 0.17, 0.13), (x - 0.01, y + 0.14, z), 0x38383d, roll=-0.35)    # bent legs
    box((0.14, 0.17, 0.17), (x + 0.03, y + 0.29, z), coat, roll=-0.45)       # leaning in
    box((0.09, 0.09, 0.09), (x + 0.09, y + 0.4, z), 0xf2bf99)
    box((0.1, 0.06, 0.1), (x + 0.09, y + 0.47, z), hat)

def sled(x, y, z, yaw, color=0xcf534f, L=0.6):
    """A sled `L` long along +X turned by `yaw`, its deck on two runners
    curling up at the front: three blocks."""
    c, s = math.cos(yaw), math.sin(yaw)
    box((L * 0.85, 0.06, 0.24), (x - L * 0.05 * c, y + 0.1, z + L * 0.05 * s), color, yaw=yaw)
    for sd in (-1, 1):
        box((L, 0.06, 0.06), (x + sd * 0.09 * s, y + 0.03, z + sd * 0.09 * c), 0x555b66, yaw=yaw)

def cabin_hut(w, h, d, at, wall, roof, yaw=0.0):
    """A small gabled hut at its real size (one or two units across), door on
    +X turned by `yaw`, trimmed as hut() is at the size of its parts: a grey
    plinth, a dark door in a white frame, a window either side, a chunky roof
    under a grey ridge."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def part(dx, dy, dz, size, color, pitch=0.0):
        box(size, (x + dx * c + dz * s, y + dy, z - dx * s + dz * c), color, yaw=yaw, pitch=pitch)
    part(0, h / 2, 0, (w, h, d), wall)
    part(0, 0.04, 0, (w + 0.08, 0.08, d + 0.08), 'grey')
    dw = d * 0.34
    part(w / 2 + 0.02, h * 0.37, 0, (0.06, h * 0.74 + 0.06, dw + 0.08), 'white')
    part(w / 2 + 0.045, h * 0.34, 0, (0.06, h * 0.68, dw), 'slate')
    for k in (-1, 1):
        part(0, h * 0.58, k * (d / 2 + 0.02), (w * 0.4 + 0.08, h * 0.3 + 0.08, 0.06), 'white')
        part(0, h * 0.58, k * (d / 2 + 0.045), (w * 0.4, h * 0.3, 0.06), 'slate')
        part(0, h + 0.1, k * (d + 0.2) / 4, (w + 0.2, 0.1, (d + 0.2) * 0.55), roof, pitch=-k * 0.6)
    part(0, h + 0.13 + 0.155 * (d + 0.2), 0, (w + 0.24, 0.09, 0.14), 'grey')

def pylon(at, h, yaw, ground=0.0):
    """A lift tower standing on `ground`, its crossarm at `h` across the line
    (the line runs along the tower's turned +Z), at a real tower's size: a
    column four units tall at most, the sheaves either side at the gauge.
    Painted red, as many resorts paint theirs, and a little stout: grey on
    the shaded snow, the line of towers up the flank was lost from the road."""
    x, _, z = at
    box((0.3, h - ground + 0.5, 0.3), (x, (h + ground - 0.5) / 2, z), 0xcf534f, yaw=yaw)
    box((1.4, 0.16, 0.16), (x, h + 0.08, z), 0xcf534f, yaw=yaw)
    for s in (-1, 1):
        gx, gz = turned(x, z, yaw, s * GAUGE, 0)
        box((0.12, 0.1, 0.4), (gx, h, gz), 0x2a2735, yaw=yaw)
    # the footing reaches well under the slope: the terrain is a 9 u grid's
    # chords across the curve this stands on, a little under it on a crest
    box((0.6, 0.6, 0.6), (x, ground - 0.2, z), 0x868ba1, yaw=yaw)

GAUGE = 0.55   # half the lift's gauge: the haul rope either side of the towers

def chair(at, yaw, color=0x3f7bd9, riders=()):
    """A two-seat chair hanging under the cable at `at`, facing down the line,
    half a unit across; `riders` are the coats of whoever sits in it. Returns
    its parts."""
    x, y, z = at
    # the hanger runs up past the rope to its grip: the rope is a smooth curve
    # through the towers, so between them it sits a little off the line
    parts = [box((0.06, 0.72, 0.06), (x, y - 0.06, z), 0x2a2735, yaw=yaw)]
    for (lx, ly, lz, size, c) in ((0, -0.45, 0.04, (0.52, 0.06, 0.2), color),
                                  (0, -0.35, -0.07, (0.52, 0.2, 0.06), color)):
        px, pz = turned(x, z, yaw, lx, lz)
        parts.append(box(size, (px, y + ly, pz), c, yaw=yaw))
    for i, coat in enumerate(riders):
        lx = (-0.13, 0.13)[i]
        px, pz = turned(x, z, yaw, lx, -0.01)
        parts.append(box((0.13, 0.16, 0.12), (px, y - 0.34, pz), coat, yaw=yaw))
        parts.append(box((0.09, 0.09, 0.09), (px, y - 0.21, pz), 0xf2bf99, yaw=yaw))
    return parts

def station(x, z, y, ground, yaw, roof=0xff5040):
    """A lift station at its real size: the bullwheel the haul rope turns
    round, at the gauge, under a red roof on four legs."""
    cyl(GAUGE + 0.03, 0.08, (x, y - 0.04, z), 0x555b66, segs=10)
    box((0.14, 0.52, 0.14), (x, y + 0.26, z), 0x555b66)
    top = y + 0.52
    for sx in (-1, 1):
        for sz in (-1, 1):
            px, pz = turned(x, z, yaw, sx * 0.8, sz * 0.55)
            box((0.1, top - ground + 0.3, 0.1), (px, (top + ground - 0.3) / 2, pz), 0x555b66, yaw=yaw)
    box((2.0, 0.12, 1.4), (x, top + 0.06, z), roof, yaw=yaw)

def snowcat(x, y, z, k=0.45):
    """A piste groomer facing +X, built like the cars: two broad tracks, a red
    body and cab with dark glass, the blade up front, the tiller behind,
    lamps on the roof. `k` sizes it (0.45: a real groomer's 1.5 units). Its
    pivot is under the middle of its tracks."""
    RED, DARK, GLASS = 0xcf534f, 0x38383d, 0x2f3a4a
    def b(size, dx, dy, dz, color):
        box([s * k for s in size], (x + dx * k, y + dy * k, z + dz * k), color)
    for s in (-1, 1):
        b((3.2, 0.7, 0.62), 0, 0.35, s * 0.82, DARK)
        b((3.0, 0.14, 0.66), 0, 0.74, s * 0.82, 0x868ba1)
    b((2.3, 0.6, 1.5), -0.1, 1.0, 0, RED)
    b((1.4, 1.0, 1.4), 0.15, 1.8, 0, RED)
    b((0.14, 0.62, 1.16), 0.86, 1.88, 0, GLASS)
    for s in (-1, 1):
        b((0.9, 0.55, 0.14), 0.2, 1.9, s * 0.71, GLASS)
    b((1.5, 0.14, 1.5), 0.15, 2.36, 0, 0xfff6eb)
    b((0.3, 0.2, 0.9), 0.5, 2.52, 0, 0xff7e44)
    b((0.3, 1.0, 2.5), 1.95, 0.6, 0, 0xfff6eb)                 # the blade
    b((0.7, 0.36, 2.2), -1.95, 0.4, 0, DARK)                    # the tiller

@piece(1.0)
def ski_lift():
    # Powder: a ski mountain standing along the road, its summit behind (-X)
    # and its long flank toward the road, so the lap drives past the whole of
    # it side-on. The mountain is the TRACK's terrain (SET_GROUND); this is
    # what stands on it, every part at its real size: a chairlift's towers
    # (four units at most) march up that flank on the diagonal from a valley
    # station by the road to the top station on the summit, the chairs (half
    # a unit across, skiers sat in most going up) riding up one side and down
    # the other round the haul rope's loop (anim_path); skiers run down the
    # slalom on the other diagonal to the finish banner on the flat, where
    # they ski into the timing hut (their way back up is out of sight, under
    # the snow, to the top hut); a groomer crawls up and down the piste. A
    # queue at the valley station, skis racked, the resort's chalets round
    # it on the flat by the road, pines on the flanks.
    H = set_ground('ski-lift')
    G = 1.35                                   # the old build's grow: where things stand on the mountain
    V, T = (12.0 * G, -22.0 * G), (-36.0 * G, -3.0 * G)            # valley and top wheels
    dx, dz = T[0] - V[0], T[1] - V[1]
    L = math.hypot(dx, dz)
    yaw = math.atan2(dx, dz)
    nx, nz = dz / L, -dx / L                          # across the line
    CAB = 3.0                                         # the cable over the snow at a tower
    y0, y1 = 1.1, H(*T) + 1.1                         # and at the wheels, where the chairs are boarded
    fr = [k / 8 for k in range(1, 8)]
    line = [(0.0, y0)] + [(f, H(V[0] + dx * f, V[1] + dz * f) + CAB) for f in fr] + [(1.0, y1)]
    def cy(f):
        for (fa, ya), (fb, yb) in zip(line[:-1], line[1:]):
            if fa <= f <= fb:
                return ya + (yb - ya) * (f - fa) / (fb - fa)
        return line[-1][1]
    for f in fr:
        x, z = V[0] + dx * f, V[1] + dz * f
        pylon((x, 0, z), cy(f), yaw, ground=H(x, z))
    # the rope in straight spans from sheave to sheave, a bar a span (a
    # third of the vertices a swept tube fine enough to lie on them costs)
    for s in (-GAUGE, GAUGE):
        for (fa, ya), (fb, yb) in zip(line[:-1], line[1:]):
            strut((V[0] + dx * fa + nx * s, ya, V[1] + dz * fa + nz * s),
                  (V[0] + dx * fb + nx * s, yb, V[1] + dz * fb + nz * s), 0.07, 0x2a2735)
    # the haul rope's loop: up one side, round the top wheel, down the other;
    # the renderer carries the chairs round it (anim_path), facing their way
    up = [(V[0] + dx * f + nx * GAUGE, y, V[1] + dz * f + nz * GAUGE) for f, y in line]
    down = [(V[0] + dx * f - nx * GAUGE, y, V[1] + dz * f - nz * GAUGE) for f, y in reversed(line)]
    for k, pt in enumerate(up + down):
        marker('path_lift_%d' % k, pt)
    COATS = (0xcf534f, 0x3f7bd9, 0x61cb8b, 0xffc044, 0xa878e8, 0xff7e44)
    for k in range(8):
        f = (k + 1) / 9                                # clear of the wheels, where the rope curls
        at = (V[0] + dx * f + nx * GAUGE, cy(f), V[1] + dz * f + nz * GAUGE)   # rest spot, any will do
        riders = ((COATS[k % 6], COATS[(k + 2) % 6]), (COATS[(k + 4) % 6],), ())[k % 3]
        with animated('anim_path:c=lift:p=60:o=%.3f:f=1#%d' % (k / 8, k), at):
            chair(at, math.pi / 2, (0x3f7bd9, 0xff5040)[k % 2], riders)   # faces +X, the way it rides
    # valley station on the flat by the road, its hut behind it, skis racked,
    # a queue waiting at the gate
    station(V[0], V[1], y0, 0.0, yaw)
    hx, hz = turned(V[0], V[1], yaw, 0.0, -2.0)
    cabin_hut(1.6, 0.9, 1.2, (hx, 0, hz), 0x9a7b55, 0xeef4f9, yaw=yaw + math.pi / 2)
    for k in range(5):
        px, pz = turned(V[0], V[1], yaw, 1.5, -0.6 + k * 0.16)
        box((0.06, 0.44, 0.07), (px, 0.22, pz), COATS[k], yaw=yaw, roll=0.15)
    for k in range(3):
        px, pz = turned(V[0], V[1], yaw, -0.25 + 0.3 * k, 1.3 + 0.12 * (k % 2))
        snow_person(px, 0, pz, COATS[k + 1], COATS[k + 3], yaw=yaw - math.pi / 2)
    # the resort's chalets round the valley station, on the flat toward the road
    for (lx, lz, w, d, wall, ry) in ((4.5, -3.0, 2.2, 1.6, 0x9a5f3c, 0.3), (5.5, 1.2, 1.8, 1.4, 0xcf534f, -0.2),
                                     (2.6, 4.2, 2.0, 1.5, 0x9a7b55, 0.5)):
        cabin_hut(w, 0.95, d, (V[0] + lx, 0, V[1] + lz), wall, 0xeef4f9, yaw=ry)
    for k in range(2):
        snow_person(V[0] + 3.2 + 0.5 * k, 0, V[1] - 0.6 + 0.9 * (k % 2), COATS[k], COATS[(k + 2) % 6], yaw=1.2 * k)
    # top station on the summit, its hut behind it
    station(T[0], T[1], y1, H(*T) - 0.3, yaw)
    tx, tz = turned(T[0], T[1], yaw, 0.0, 2.0)
    cabin_hut(1.6, 0.9, 1.2, (tx, H(tx, tz) - 0.1, tz), 0x9a7b55, 0xeef4f9, yaw=yaw)
    # the slalom down the other diagonal to the finish on the flat
    S0, F = (-6.0 * G, 5.0 * G), (12.0 * G, 21.0 * G)
    px_, pz_ = F[0] - S0[0], F[1] - S0[1]
    pl = math.hypot(px_, pz_)
    pyaw = math.atan2(px_, pz_)
    qx, qz = pz_ / pl, -px_ / pl
    gates = []
    for k in range(6):
        f = 0.08 + k * 0.155
        s2 = 0.9 if k % 2 else -0.9
        x, z = S0[0] + px_ * f + qx * s2, S0[1] + pz_ * f + qz * s2
        gates.append((x - qx * s2 * 0.3, z - qz * s2 * 0.3))     # the skier's line, inside each gate
        c = 0xff5040 if k % 2 == 0 else 0x339cf2
        g = H(x, z)
        for e in (-0.22, 0.22):
            ex, ez = turned(x, z, pyaw, e, 0)
            box((0.06, 0.8, 0.06), (ex, g + 0.12, ez), c, yaw=pyaw)    # sunk past the grid's chords
        box((0.44, 0.24, 0.06), (x, g + 0.4, z), c, yaw=pyaw)
    for e in (-1.6, 1.6):
        ex, ez = turned(F[0], F[1], pyaw, e, 0)
        box((0.14, 1.5, 0.14), (ex, H(ex, ez) + 0.55, ez), 0x555b66, yaw=pyaw)
    box((3.4, 0.4, 0.08), (F[0], H(*F) + 1.15, F[1]), 0x339cf2, yaw=pyaw)
    box((1.4, 0.24, 0.1), (F[0], H(*F) + 1.15, F[1]), 0xfff6eb, yaw=pyaw)
    fx, fz = turned(F[0], F[1], pyaw, 2.4, 1.2)                          # the timing hut
    cabin_hut(1.1, 0.8, 1.0, (fx, H(fx, fz) - 0.05, fz), 0x9a7b55, 0xeef4f9, yaw=pyaw - math.pi / 2)
    # the skiers' loop: out of the top hut, over the summit to the start, the
    # gates down the slalom, through the finish and into the timing hut, then
    # back up out of sight, under the snow, to the top hut
    run = [(tx, tz), (-32.0 * G, 12.0 * G)] + gates + [F, (fx, fz)]
    surf = []
    for (ax, az), (bx, bz) in zip(run[:-1], run[1:]):
        n = max(1, int(math.hypot(bx - ax, bz - az) / 2.5))
        for i in range(n):
            x, z = ax + (bx - ax) * i / n, az + (bz - az) * i / n
            surf.append((x, H(x, z) + 0.02, z))
    surf.append((fx, H(fx, fz) + 0.02, fz))
    under = [(x, H(x, z) - 1.6, z) for (x, _, z) in reversed(surf[::3] + [surf[-1]])]
    for k, pt in enumerate(surf + under):
        marker('path_ski_%d' % k, pt)
    for k in range(4):
        x, y, z = surf[3 + k * 4]
        with animated('anim_path:c=ski:p=70:o=%.3f#%d' % (k / 4, k), (x, y, z)):
            skier(x, y, z, COATS[k], COATS[(k + 3) % 6])
    # the piste runs on up from the slalom to the top station (its blue wash
    # is the terrain's, SET_GROUND's `paint`); a groomer works it, crawling up
    # one side and back down the other (anim_path, pitched to the slope)
    groom = [(-32.0 * G, 12.0 * G), S0, F]
    def along(off, back):
        pts = []
        for (ax, az), (bx, bz) in zip(groom[:-1], groom[1:]):
            l = math.hypot(bx - ax, bz - az)
            nx_, nz_ = -(bz - az) / l, (bx - ax) / l
            for i in range(8):
                f = i / 8
                pts.append((ax + (bx - ax) * f + nx_ * off, az + (bz - az) * f + nz_ * off))
        pts.append((groom[-1][0] + nx_ * off, groom[-1][1] + nz_ * off))
        return list(reversed(pts)) if back else pts
    loop = along(-3.4, False) + along(3.4, True)
    for k, (x, z) in enumerate(loop):
        marker('path_groom_%d' % k, (x, H(x, z) + 0.02, z))
    x, z = loop[3]
    with animated('anim_path:c=groom:p=60:f=2#cat', (x, H(x, z) + 0.02, z)):
        snowcat(x, H(x, z) + 0.02, z)
    # pines on the flanks, clear of the lift line and the piste, the size of
    # the ambient ones
    for x, z, k in ((-50.0, -30.0, 1.9), (-12.0, 20.0, 1.8)):
        x, z = x * G, z * G
        pine((x, H(x, z) - 0.6, z), k)   # sunk past the grid's chords

# Powder's second lift runs up the foothills over the start straight's
# outside (tracks.js powder `land`, its forms `near` the kerb), so it stands
# on the TRACK's terrain, not a mound of its own: the ground along its line as
# the renderer draws it, sampled (the display's groundY over the plain) every
# 2 u along the piece's +X from the bottom wheel to the top wheel. Re-sample
# whenever the land or the piece moves.
CHAIRLIFT_GROUND = ((-14.0, 1.0), (-12.0, 0.9), (-10.0, 0.7), (-8.0, 0.5), (-6.0, 0.4), (-4.0, 0.3), (-2.0, 0.3),
                    (0.0, 0.3), (2.0, 0.3), (4.0, 0.3), (6.0, 1.0), (8.0, 1.3), (10.0, 1.7), (12.0, 2.1), (14.0, 3.1),
                    (16.0, 4.7), (18.0, 6.3), (20.0, 7.9), (22.0, 9.5), (24.0, 10.6), (26.0, 12.0), (28.0, 13.3),
                    (30.0, 14.6), (32.0, 15.2), (34.0, 15.3))

def chairlift_ground(x):
    pts = CHAIRLIFT_GROUND
    if x <= pts[0][0]:
        return pts[0][1]
    for (x0, h0), (x1, h1) in zip(pts, pts[1:]):
        if x <= x1:
            return h0 + (h1 - h0) * (x - x0) / (x1 - x0)
    return pts[-1][1]

@piece(1.0)
def powder_chairlift():
    # Powder: the resort's second chairlift, from its base inside the north
    # loop over the start straight and up the foothills to their crest, the
    # chairs (skiers riding up, the odd one coming down empty) crossing over
    # the cars' heads. Placed at u 0.0317, lat 0, yaw 0: +X north, up the
    # line (the road crosses it at x -3..3), +Z east along the straight. Every
    # part at its real size; the two towers either side of the road hold the
    # rope high enough that a chair clears the deck by OVER_GAP. What stands
    # on the snow lies on it as drawn (drape_), so the piece stands on the
    # plain and levels nothing; the line is built over the plain against
    # CHAIRLIFT_GROUND, the towers' and stations' feet down through the hill
    # to the plain.
    H = chairlift_ground
    yaw = math.pi / 2                                 # the line runs along +X
    X0, X1 = -12.0, 30.0                              # the valley and top wheels
    y0, y1 = H(X0) + 1.1, H(X1) + 1.1                 # where the chairs are boarded
    towers = ((-5.0, 5.0), (7.0, max(5.6, H(7.0) + 3.0)), (17.0, H(17.0) + 3.0), (25.0, H(25.0) + 3.0))
    line = [(X0, y0)] + list(towers) + [(X1, y1)]
    def cy(x):
        for (xa, ya), (xb, yb) in zip(line, line[1:]):
            if xa <= x <= xb:
                return ya + (yb - ya) * (x - xa) / (xb - xa)
        return line[-1][1]
    for x, h in towers:
        pylon((x, 0, 0.0), h, yaw)                    # its foot in the hill, down to the plain
    for s in (-GAUGE, GAUGE):
        for (xa, ya), (xb, yb) in zip(line, line[1:]):
            strut((xa, ya, s), (xb, yb, s), 0.07, 0x2a2735)
    up = [(x, y, GAUGE) for x, y in line]
    down = [(x, y, -GAUGE) for x, y in reversed(line)]
    for k, pt in enumerate(up + down):
        marker('path_plift_%d' % k, pt)
    COATS = (0xcf534f, 0x3f7bd9, 0x61cb8b, 0xffc044, 0xa878e8, 0xff7e44)
    for k in range(8):
        x = X0 + (X1 - X0) * (k + 1) / 9
        at = (x, cy(x), GAUGE)
        riders = ((COATS[k % 6], COATS[(k + 2) % 6]), (COATS[(k + 4) % 6],), ())[k % 3]
        with animated('anim_path:c=plift:p=42:o=%.3f:f=1#%d' % (k / 8, k), at):
            chair(at, yaw, (0xff5040, 0x3f7bd9)[k % 2], riders)
    # the two stations, their legs down through the snow to the plain
    station(X0, 0.0, y0, 0.0, yaw)
    station(X1, 0.0, y1, 0.0, yaw)
    # On the snow as drawn: the stations' huts, the resort's chalets either
    # side of the valley station along the straight's verge (doors to the
    # road), the queue at its gate, the racked skis. The towers stand
    # straight in the snow: a footing slab on the slope showed its side.
    def build():
        cabin_hut(1.6, 0.9, 1.2, (X0 - 2.0, -0.1, 0.0), 0x9a7b55, 0xeef4f9)
        cabin_hut(1.6, 0.9, 1.2, (X1 + 2.0, -0.1, 0.0), 0x9a7b55, 0xeef4f9)
        # The resort's village, laid out as one: a lane of trodden snow runs
        # along the straight behind a rail fence, widening to a little square
        # at the lift's gate; the chalets stand in a row along its far side,
        # doors to the lane, a path from each door to it; lamps along the
        # fence, a fir by a gable, woodpiles, a bench, a sled left out. (Four
        # chalets stood here every which way, with nothing between them.)
        LANE = 0xd0e8ff
        def lane_x(z):
            return -8.2 + 0.35 * math.sin(z / 4.5)
        zs = [-18.0 + i for i in range(37)]
        rows = [[(lane_x(z) - 0.75, 0.05, z), (lane_x(z) + 0.75, 0.05, z)] for z in zs]
        for o in sheet(rows, lambda i, j, nn: LANE, 'lane'):
            snowy(o, 0.3)
        snowy(cyl(2.1, 0.05, (-9.4, 0.0, 0.0), LANE, segs=14), 0.3)             # the square at the gate
        HOUSES = ((-16.2, 2.3, 1.7, 0x9a5f3c, 0.06, True), (-12.4, 2.0, 1.6, 0xcf534f, -0.05, False),
                  (-8.6, 2.5, 1.8, 0x9a7b55, 0.04, True), (-4.9, 1.9, 1.5, 0x3f7bd9, -0.06, False),
                  (4.9, 2.1, 1.6, 0xffc044, 0.05, False), (8.6, 2.5, 1.8, 0x9a5f3c, -0.04, True),
                  (12.4, 2.0, 1.6, 0x61cb8b, 0.06, False), (16.2, 2.3, 1.7, 0xcf534f, -0.05, True))
        for n, (z, w, d, wall, ry, smoke) in enumerate(HOUSES):
            hx = -11.9 - 0.3 * (n % 2)
            cabin_hut(w, 1.05, d, (hx, -0.15, z), wall, 0xeef4f9, yaw=ry)
            # its path to the lane
            x0, x1 = hx + w / 2, lane_x(z) - 0.6
            snowy(box((x1 - x0 + 0.2, 0.06, 0.6), ((x0 + x1) / 2, 0.03, z), LANE), 0.3)
            if smoke:                                                           # a chimney on the back slope
                box((0.3, 0.6, 0.3), (hx - w * 0.25, 1.35, z - d * 0.2), 0x868ba1)
                snowy(box((0.38, 0.08, 0.38), (hx - w * 0.25, 1.68, z - d * 0.2), 0xeef4f9), 0.4)
        # the rail fence between the lane and the road, open at the square
        fz = [-18.0 + 1.5 * i for i in range(25)]
        for za, zb in zip(fz, fz[1:]):
            if abs((za + zb) / 2) < 2.6:
                continue
            xa, xb = lane_x(za) + 1.25, lane_x(zb) + 1.25
            box((0.1, 0.55, 0.1), (xa, 0.27, za), 0x8a6a46)
            for ry_ in (0.24, 0.46):
                strut((xa, ry_, za), (xb, ry_, zb), 0.07, 0x9a7b55)
            if abs(zb) < 2.6 + 1.5 or zb == fz[-1]:
                box((0.1, 0.55, 0.1), (xb, 0.27, zb), 0x8a6a46)
        # lamps along the fence
        for z in (-15.0, -9.0, -3.5, 3.5, 9.0, 15.0):
            lx = lane_x(z) + 1.25
            box((0.09, 1.5, 0.09), (lx, 0.75, z), 0x38383d)
            box((0.4, 0.07, 0.07), (lx - 0.18, 1.5, z), 0x38383d)
            box((0.2, 0.2, 0.2), (lx - 0.36, 1.38, z), 0xffc044)
        # what stands in the gardens
        woodpile(-13.6, -10.5, 0.26)
        woodpile(-13.8, 6.8, 0.26)
        sled(-9.8, 0, -6.8, 0.7, 0xcf534f, L=0.6)
        bench((-9.6, 0, 3.2), yaw=math.pi / 2, color=0x9a7b55)
        snow_heap((-10.2, 0, 10.6), 0.5, yaw=0.4)
        snow_heap((-10.4, 0, -14.2), 0.45, yaw=1.1)
        for k in range(4):
            snow_person(X0 + 2.4 - 0.32 * k, 0.0, -1.0 + 0.1 * (k % 2), COATS[(k + 1) % 6], COATS[(k + 3) % 6], yaw=math.pi)
        for k in range(5):
            box((0.06, 0.44, 0.07), (X0 - 0.6, 0.22, 1.4 + k * 0.16), COATS[k], roll=0.15)
    draped('base', build)
    # smoke from the chalets that have a fire in (the marker rides the land
    # under it with the chimney it stands on)
    for n, z in enumerate((-16.2, -8.6, 8.6, 16.2)):
        marker('anim_smoke#v%d' % n, (-11.9 - 0.3 * ((0, 2, 5, 7)[n] % 2) - (2.3, 2.5, 2.5, 2.3)[n] * 0.25, 2.0,
                                      z - (1.7, 1.8, 1.8, 1.7)[n] * 0.2))

# Stands of pines up the foothills the snow tracks' `land` raises by the road
# (tracks.js powder and flurry), where the verge's scatter never reaches: the
# white flanks read as mountainside only with forest on them. Each stand is a
# piece of its own, so its footprint (which keeps the scatter out) is only the
# stand's. Every tree is (x, z, ground, size) in its piece's frame: the ground
# the renderer draws there over the plain, SAMPLED (the display's groundY), so
# re-sample a stand whenever the land under it moves.
FORESTS = {
    'powder-forest-a': ((-0.0, 8.6, 7.91, 1.60), (-2.4, 11.4, 5.45, 1.68), (0.7, -9.0, 7.78, 1.73), (-4.1, -1.3, 5.15, 1.92), (-4.3, 4.9, 4.91, 1.82), (4.9, 3.6, 12.18, 1.42), (-7.6, 2.1, 3.18, 1.82), (-5.0, 0.5, 4.43, 1.99), (-0.3, 5.6, 8.16, 1.81), (1.0, -0.5, 9.51, 1.66), (4.2, 7.0, 11.65, 1.43), (5.7, -9.9, 10.63, 1.61), (0.7, 1.3, 9.14, 1.92), (8.2, 4.4, 13.58, 1.58), (-7.0, 5.6, 3.41, 2.11), (8.9, -1.6, 14.36, 1.99), (-1.9, -6.1, 6.51, 1.84), (7.6, -6.5, 12.57, 1.79), (5.8, -4.1, 12.46, 2.03), (-3.4, -11.6, 3.99, 2.15), (0.2, -6.3, 8.26, 1.39), (-0.5, -4.3, 8.01, 1.65), (2.8, -12.0, 8.45, 1.43), (1.1, 12.7, 7.87, 1.97)),
    'powder-forest-b': ((2.4, 9.4, 7.75, 2.01), (4.6, 10.0, 8.87, 2.03), (3.2, -9.8, 12.16, 2.01), (-5.4, 8.0, 4.28, 1.95), (6.2, 0.7, 11.92, 1.91), (6.7, 5.9, 10.73, 1.43), (-6.2, -9.6, 5.30, 1.88), (-0.0, -0.3, 8.32, 2.03), (-5.2, 3.8, 4.16, 1.68), (-3.4, 8.8, 5.66, 2.08), (-5.5, -7.3, 5.64, 1.81), (-4.3, -0.0, 5.36, 2.02), (-4.3, -11.2, 6.91, 1.52), (-2.0, -9.1, 8.61, 1.89), (2.2, 4.6, 8.70, 1.42), (1.1, -9.8, 11.15, 1.48), (-7.4, -3.2, 4.13, 2.01), (8.0, 0.1, 12.74, 1.80), (3.0, -2.3, 11.31, 2.01), (3.6, 7.2, 8.91, 2.15), (1.5, 1.0, 9.06, 1.54), (5.2, -8.5, 12.99, 1.36)),
    'powder-forest-c': ((3.4, 0.9, 2.98, 2.03), (1.3, -5.0, 5.31, 1.93), (4.0, -16.0, 11.97, 1.79), (5.4, -10.0, 9.65, 2.01), (1.9, 13.9, 6.67, 2.08), (0.6, 6.2, 2.60, 1.89), (6.0, 3.0, 2.77, 1.66), (5.7, -3.6, 6.31, 1.44), (4.5, 11.2, 6.06, 1.73), (-3.8, -10.3, 3.66, 2.04), (3.1, -8.3, 7.61, 1.51), (0.7, -11.9, 7.80, 2.00), (-1.3, -11.7, 6.12, 1.37), (0.5, 3.9, 2.15, 1.89), (-2.2, 12.3, 3.81, 1.72), (3.8, 3.7, 2.46, 1.81), (2.8, -14.4, 10.51, 1.77), (-1.9, -2.1, 2.98, 1.55), (-4.8, -1.7, 1.68, 1.92), (-0.5, -0.1, 2.24, 2.07), (6.5, 0.8, 4.21, 2.11), (1.1, 9.8, 4.16, 1.91), (3.2, -19.4, 11.68, 1.76), (-6.4, 20.4, 4.87, 1.43)),
    'powder-forest-d': ((-6.4, -0.3, 2.49, 1.64), (0.6, 3.4, 7.58, 1.48), (-6.9, 5.6, 2.06, 2.08), (-0.5, 5.3, 6.46, 2.05), (-2.0, 7.8, 5.29, 1.36), (-7.0, -3.7, 1.56, 1.47), (1.2, -5.0, 8.51, 2.10), (-3.7, -1.5, 4.78, 1.89), (-0.8, -0.5, 7.02, 1.95), (7.8, -4.1, 15.21, 1.61), (-4.4, 0.3, 4.32, 1.37), (5.9, -6.4, 12.45, 2.10), (2.2, 7.8, 7.72, 1.93), (2.0, -7.2, 8.59, 1.41), (4.2, 0.7, 11.54, 2.01), (-2.1, -4.3, 5.77, 1.39), (-2.3, -7.2, 4.75, 2.00), (1.7, -1.5, 9.30, 1.93)),
    'powder-forest-e': ((6.4, 0.4, 5.47, 1.74), (0.1, -13.5, 7.97, 1.68), (3.3, 0.9, 8.10, 1.52), (1.0, 9.0, 7.35, 1.62), (0.4, -10.0, 8.84, 1.59), (2.7, -12.9, 5.61, 1.61), (-7.5, -0.1, 16.84, 2.11), (-4.3, -2.4, 14.39, 1.36), (-5.7, 6.6, 15.07, 2.11), (4.5, 9.2, 4.71, 1.47), (-0.7, 2.4, 11.36, 1.87), (2.2, 4.1, 7.94, 1.77), (-4.2, -8.6, 14.16, 1.85), (6.2, 3.5, 4.99, 1.96), (6.0, -2.3, 5.66, 1.53), (3.2, -8.5, 6.33, 1.48), (6.0, -4.9, 5.09, 1.43), (-0.6, -6.3, 10.49, 1.92), (-3.8, 2.4, 14.09, 1.71), (6.4, -6.7, 4.41, 1.49), (4.1, -3.8, 6.63, 1.97), (2.8, 10.0, 5.62, 1.45)),
    'powder-forest-f': ((-1.1, 2.9, 4.91, 1.76), (0.9, -0.9, 6.47, 1.58), (-5.7, -0.5, 3.00, 2.09), (-0.0, 1.2, 6.24, 1.68), (-3.4, 4.3, 3.08, 1.76), (1.0, 4.9, 5.70, 1.64), (3.0, -1.5, 7.46, 1.90), (5.1, 1.4, 9.03, 1.96), (-3.3, -4.1, 3.98, 1.79), (-0.9, 6.2, 4.00, 2.01), (-1.7, -2.4, 4.96, 1.83), (-0.1, -5.7, 5.19, 1.79)),
    'powder-forest-g': ((6.8, 1.2, 15.15, 1.39), (-2.2, 5.7, 9.82, 1.83), (-3.6, 8.0, 8.13, 1.38), (4.8, -9.6, 11.34, 1.41), (-3.4, -4.1, 8.83, 1.61), (-2.2, -1.5, 10.60, 1.67), (-0.3, 7.2, 10.78, 2.03), (6.7, -4.3, 14.19, 1.88), (2.4, 2.0, 12.66, 1.55), (-6.5, 6.6, 6.69, 1.76), (4.2, 1.4, 13.76, 1.77), (3.4, 5.7, 13.23, 1.64), (-4.0, 11.5, 6.29, 1.77), (4.0, -6.6, 12.21, 2.06), (-2.6, 1.0, 10.08, 1.85), (-0.3, 12.4, 8.27, 1.94), (-5.8, 8.6, 6.96, 1.58), (0.3, 4.0, 11.35, 2.00)),
    'powder-forest-h': ((5.4, -5.8, 6.25, 1.81), (6.1, -2.0, 7.68, 2.08), (-1.9, -2.4, 2.54, 1.41), (8.9, 2.3, 10.50, 1.87), (1.5, -1.1, 4.74, 1.47), (7.3, 6.8, 9.53, 1.71), (0.3, -3.1, 3.50, 1.69), (2.3, 9.1, 5.40, 2.13), (-0.8, 5.8, 3.08, 1.61), (3.4, -6.6, 4.77, 1.71), (3.9, 4.1, 7.56, 1.42), (1.9, 0.8, 5.44, 1.53), (10.0, 5.5, 10.79, 1.91), (-2.7, -5.1, 1.92, 1.47), (0.4, -6.1, 3.18, 1.78), (0.4, 7.4, 3.87, 2.11), (-3.0, -7.0, 1.60, 2.10), (8.2, -1.8, 9.32, 1.58), (-2.3, -10.5, 1.37, 1.60), (-1.9, 1.3, 2.74, 1.93), (4.5, 10.6, 6.41, 1.78), (-4.0, 7.4, 1.40, 1.51), (1.7, 6.2, 5.25, 2.05), (10.6, 0.4, 11.35, 2.14), (7.0, 2.4, 9.40, 2.07), (1.3, 3.4, 5.06, 1.69)),
    'flurry-forest-a': ((-1.6, 0.3, 3.22, 1.65), (-2.9, 2.6, 3.69, 1.99), (-1.4, -7.8, 3.22, 1.70), (-11.1, -26.7, 3.80, 1.78), (-1.8, -2.2, 3.47, 1.80), (-14.9, -26.0, 4.59, 1.77), (-3.1, -0.8, 4.57, 2.09), (-15.3, -22.4, 6.32, 1.89), (-0.1, -3.5, 2.38, 1.85), (-6.7, 1.9, 7.54, 1.61), (-19.1, -21.7, 7.29, 1.50), (-18.7, -17.4, 10.25, 1.64), (-0.8, 15.4, 2.81, 1.76), (-2.0, 10.4, 2.84, 1.36), (-9.5, -3.3, 10.55, 1.64), (-3.2, 16.7, 4.39, 1.73), (-6.8, 7.3, 6.04, 2.14), (2.0, -6.7, 1.29, 1.79), (-22.2, -17.1, 11.18, 2.13), (-21.8, -12.9, 14.65, 1.74), (6.0, 15.6, 0.54, 1.70), (-8.4, 3.8, 8.82, 1.68), (-0.5, 9.0, 1.86, 1.89), (-25.8, -13.5, 14.76, 1.83), (-11.9, -31.3, 3.50, 2.08), (-8.8, 6.0, 8.68, 1.89), (-0.4, 12.4, 2.31, 1.36), (1.8, -4.9, 1.28, 1.93), (-0.8, 5.9, 1.84, 1.36), (-7.0, 5.5, 6.76, 2.07)),
    'flurry-forest-b': ((-5.5, -11.7, 15.34, 2.08), (-5.0, 7.1, 8.81, 1.43), (0.4, -3.4, 6.08, 1.43), (-4.4, -9.7, 12.81, 1.64), (3.8, 5.0, 3.34, 1.45), (-3.0, -3.6, 11.54, 2.08), (-1.0, -13.4, 8.73, 1.78), (0.4, -10.2, 4.41, 1.65), (-6.6, 3.6, 11.37, 1.48), (6.3, 11.8, 1.86, 2.03), (-8.1, -7.0, 18.84, 1.53), (-10.3, -4.3, 18.80, 2.13), (-3.8, -6.2, 13.29, 1.84), (-1.7, 7.9, 5.95, 1.46), (1.8, 4.5, 4.97, 1.38), (3.7, 7.3, 2.48, 1.73), (-0.5, -7.9, 6.90, 1.36), (5.5, -2.6, 1.39, 1.38), (-8.9, 2.8, 13.40, 1.49), (4.0, 12.6, 2.54, 1.67), (-2.3, -0.5, 8.86, 1.82), (1.0, 7.3, 4.31, 1.49), (6.3, 8.0, 1.14, 1.57), (-5.8, -8.1, 15.10, 1.71), (-1.1, 4.5, 7.01, 1.93), (-8.0, 1.1, 13.53, 2.12), (6.5, -8.3, 0.80, 1.55), (-6.0, -5.3, 16.18, 1.96)),
    'flurry-forest-c': ((0.8, -2.7, 2.71, 1.69), (-4.0, -2.8, 5.53, 1.39), (-1.8, -0.7, 3.89, 1.88), (0.7, 8.4, 2.23, 1.54), (0.1, -5.2, 2.69, 1.56), (-2.0, -3.3, 4.14, 1.62), (-1.6, -7.6, 3.17, 1.53), (-2.5, 1.9, 4.66, 1.73), (-4.3, 4.1, 6.33, 1.93), (3.8, 4.9, 1.02, 1.72), (1.0, 5.3, 2.64, 1.51), (-3.4, 7.9, 5.47, 2.00), (2.8, -1.9, 1.63, 1.42), (2.6, 2.7, 1.79, 2.00), (-5.9, 5.9, 7.38, 1.88), (-2.2, 9.6, 4.40, 1.79)),
    'flurry-forest-d': ((3.0, 10.0, 3.15, 2.12), (-1.2, 8.5, 5.81, 1.44), (-2.1, 6.7, 6.66, 1.50), (-5.1, 3.8, 8.73, 1.57), (3.2, 8.0, 3.26, 2.02), (-3.1, 0.1, 8.04, 1.73), (-3.4, -5.7, 8.27, 1.98), (-3.2, 3.7, 7.74, 2.11), (2.1, -2.6, 4.48, 1.92), (3.3, -0.6, 3.70, 1.47), (-6.4, -7.4, 10.60, 1.88), (-0.9, -3.8, 6.46, 1.63), (6.0, -2.5, 1.88, 1.43), (4.0, -5.7, 3.25, 1.49), (1.5, 5.1, 4.68, 1.86), (-4.5, 2.0, 8.75, 1.88), (4.4, 2.8, 2.87, 1.40), (-4.3, 5.7, 8.00, 2.03), (2.1, -6.8, 4.26, 1.82), (7.3, 4.0, 1.07, 2.05)),
    'flurry-forest-e': ((-1.0, 4.8, 5.38, 2.13), (4.6, 3.4, 2.27, 2.13), (1.0, 6.8, 3.73, 2.03), (-3.9, -4.0, 6.88, 1.59), (-5.1, 1.3, 8.30, 1.76), (2.0, 0.1, 3.66, 1.48), (-2.2, 1.3, 6.31, 1.90), (4.3, -4.9, 2.02, 2.00), (-3.1, 5.9, 6.46, 1.61), (-5.1, -1.2, 8.01, 2.11), (0.1, 0.8, 4.68, 1.86), (-0.3, 2.7, 5.17, 1.58), (6.0, -0.8, 1.24, 2.07), (-2.4, -1.1, 6.18, 2.06)),
    'flurry-forest-f': ((3.7, -5.8, 0.22, 1.90), (-0.1, -4.2, 0.49, 2.10), (2.1, -1.8, 0.40, 1.60), (-2.5, -0.6, 0.84, 1.80), (0.5, 1.2, 0.68, 2.00), (1.5, 3.2, 0.53, 1.50), (-3.2, 4.2, 1.13, 1.70), (0.2, 5.7, 0.71, 1.90)),
    'flurry-forest-g': ((6.5, -13.7, 3.02, 1.90), (3.2, -9.6, 3.06, 2.10), (5.8, -6.1, 2.95, 1.60), (1.0, -11.5, 3.16, 1.70), (1.6, 9.4, 5.73, 2.00), (-0.3, 15.3, 9.09, 1.80), (4.0, 18.2, 9.33, 1.50), (-3.6, 14.0, 8.76, 1.90), (-7.9, -2.1, 3.23, 1.80), (-10.3, 4.2, 3.31, 1.60)),
    'flurry-forest-h': ((-4.7, -17.3, 3.66, 2.45, 0), (-4.7, -23.1, 4.09, 2.42, 0), (-4.3, -19.5, 4.05, 1.71, 0), (-3.1, -14.0, 4.58, 1.77, 0), (-7.6, -18.9, 2.83, 1.93, 0), (-7.2, -17.0, 2.92, 2.40, 0), (-0.2, -16.5, 6.72, 2.53, 0), (2.6, -18.7, 8.90, 1.72, 1), (11.9, -22.3, 16.40, 2.27, 0), (-0.1, -22.3, 6.55, 1.70, 1), (-9.5, -20.0, 2.63, 1.98, 0), (-7.1, -22.2, 2.77, 1.78, 1), (-5.2, -14.4, 3.17, 1.76, 0), (-5.8, -20.5, 3.24, 1.93, 0), (-2.5, -17.8, 4.93, 2.02, 1), (0.3, -14.7, 7.34, 1.73, 1), (-1.1, -19.5, 5.84, 1.73, 0), (4.8, -22.6, 10.95, 1.73, 0), (6.2, -14.1, 12.41, 1.81, 0), (-1.6, -23.8, 5.61, 2.31, 1), (7.5, -23.7, 13.15, 1.74, 0), (3.2, -20.5, 9.47, 1.81, 0), (-1.3, -14.2, 6.02, 1.71, 0), (1.6, -16.7, 8.24, 1.98, 0), (-3.1, -21.1, 4.80, 2.10, 1), (1.7, -23.4, 8.15, 1.77, 1), (1.1, -20.8, 7.59, 2.48, 0), (8.4, -21.3, 13.88, 2.52, 1), (-7.5, -15.2, 2.95, 2.52, 1), (-1.8, -16.0, 5.42, 2.23, 1), (-3.6, -15.7, 4.11, 1.78, 1), (-9.4, -17.2, 2.72, 2.56, 1), (1.3, -13.0, 8.33, 1.73, 0), (-8.8, -21.6, 2.64, 2.33, 0), (2.8, -14.3, 9.49, 2.28, 1), (12.3, -15.7, 16.17, 1.74, 1)),
    'flurry-forest-i': ((-5.0, 8.7, 5.20, 1.87, 0), (-3.1, 9.0, 6.05, 1.86, 0), (-1.0, 13.7, 6.23, 1.80, 0), (-2.7, 12.3, 5.65, 1.81, 0), (-5.3, 12.7, 4.39, 1.77, 0), (-3.0, 7.0, 7.11, 1.77, 0), (-2.7, 14.5, 5.31, 1.95, 1), (-7.0, 6.8, 4.81, 2.40, 0), (-7.3, 9.1, 4.36, 1.79, 0), (8.7, 9.8, 16.12, 2.48, 1), (-4.6, 6.2, 6.49, 1.91, 0), (10.4, 8.5, 16.74, 2.08, 1), (8.2, 6.7, 16.97, 1.71, 0), (12.2, 13.4, 16.35, 2.43, 1), (10.2, 5.4, 17.12, 1.89, 0), (8.1, 12.6, 15.18, 1.70, 0), (-1.8, 5.5, 8.67, 2.14, 1), (-8.0, 11.9, 3.88, 1.71, 0), (-4.3, 15.1, 4.47, 2.38, 0), (-7.4, 13.8, 3.80, 2.11, 0), (5.9, 14.7, 12.04, 2.27, 1), (-8.6, 7.6, 4.80, 1.97, 0), (-9.9, 10.0, 4.15, 1.72, 0), (5.9, 7.4, 16.12, 2.14, 1), (2.9, 13.1, 9.32, 2.70, 1), (-0.2, 15.3, 6.73, 2.31, 1), (0.9, 11.0, 7.94, 2.14, 0), (1.9, 4.1, 13.16, 1.71, 0), (3.4, 15.4, 9.74, 1.85, 0), (7.5, 4.4, 17.28, 2.14, 1), (0.1, 8.1, 8.68, 1.78, 0), (13.0, 11.7, 16.88, 1.90, 0), (-6.1, 10.8, 4.44, 1.86, 1), (5.4, 11.3, 13.33, 1.73, 0), (1.7, 15.9, 8.26, 1.79, 0), (9.9, 13.4, 15.19, 1.95, 0)),
    'flurry-forest-j': ((-4.2, -47.1, 4.69, 1.95, 1), (-5.2, -45.7, 4.04, 2.70, 1), (-10.2, -43.0, 3.31, 1.95, 0), (-6.5, -47.5, 3.76, 2.00, 0), (-3.1, -48.7, 5.36, 1.74, 1), (-8.0, -42.1, 3.43, 2.04, 0), (-7.3, -44.2, 3.60, 1.89, 1), (-6.8, -49.2, 3.77, 2.48, 1), (1.8, -45.4, 8.89, 2.19, 0), (-2.3, -39.8, 5.70, 1.79, 1), (1.1, -41.4, 8.25, 1.99, 0), (-10.2, -48.1, 3.58, 1.76, 0), (-7.0, -52.2, 3.88, 1.78, 0), (-2.2, -54.2, 6.10, 1.86, 0), (-9.3, -50.7, 3.66, 1.82, 1), (-4.8, -40.2, 4.07, 1.75, 0), (-7.9, -40.0, 3.42, 2.16, 0), (-8.3, -45.9, 3.62, 1.79, 0), (-1.5, -46.7, 6.45, 1.76, 0), (4.9, -42.5, 11.54, 2.14, 0), (-5.2, -52.5, 4.75, 1.75, 0), (-3.8, -43.6, 4.96, 1.77, 1), (2.5, -38.8, 9.23, 1.92, 0), (0.5, -43.1, 7.84, 1.72, 0), (2.8, -52.1, 9.60, 1.79, 1), (-0.9, -51.3, 6.76, 1.95, 0)),
    'flurry-forest-k': ((-5.2, 33.4, 4.77, 1.81, 1), (-8.0, 37.3, 4.33, 1.79, 0), (-3.9, 34.7, 5.35, 1.90, 0), (-10.1, 42.7, 6.03, 1.77, 0), (-3.2, 30.4, 5.02, 1.75, 0), (-5.1, 47.7, 10.45, 1.83, 0), (-1.4, 32.5, 6.08, 1.92, 1), (-3.7, 32.5, 5.13, 1.73, 1), (-8.8, 34.5, 3.74, 1.91, 0), (2.3, 34.2, 9.45, 1.87, 0), (6.3, 35.0, 12.83, 2.22, 1), (-10.6, 40.8, 5.22, 1.83, 1), (-1.1, 47.3, 12.88, 2.31, 1), (-4.1, 46.1, 10.06, 1.88, 0), (-0.6, 40.3, 9.98, 1.76, 1), (-2.1, 37.0, 7.41, 2.03, 0), (3.7, 43.3, 14.35, 1.71, 0), (-7.2, 41.5, 6.10, 2.16, 0), (-7.3, 44.0, 7.48, 2.43, 0), (-6.5, 34.6, 4.53, 1.91, 1), (0.8, 44.8, 13.00, 2.25, 0), (-6.8, 32.8, 4.19, 2.52, 0), (1.6, 32.0, 8.45, 1.73, 0), (-9.4, 38.4, 4.47, 1.80, 0), (8.8, 39.3, 15.57, 2.07, 1), (4.3, 32.9, 10.98, 1.84, 1)),
    'flurry-forest-l': ((-8.9, -38.7, 3.26, 1.82, 1), (-1.5, -51.6, 6.38, 2.27, 1), (-4.9, -14.2, 3.31, 1.79, 1), (-7.3, -17.4, 2.90, 2.02, 0), (-6.2, -50.7, 4.12, 1.74, 0), (-3.4, -29.2, 4.55, 1.77, 0), (-9.4, -34.4, 2.97, 2.02, 0), (-9.3, -24.0, 2.61, 2.24, 1), (-4.9, -22.2, 3.93, 2.33, 0), (-4.6, -1.9, 10.34, 2.12, 0), (-2.0, -24.6, 5.38, 1.81, 1), (-4.1, -8.8, 6.08, 2.20, 1), (-7.1, -10.7, 5.06, 1.78, 0), (-5.6, -45.6, 3.84, 1.73, 0), (-6.3, -31.8, 3.63, 2.14, 0), (-4.1, -43.4, 4.73, 1.82, 0), (-1.4, -14.6, 5.89, 2.34, 1), (-7.0, -34.5, 3.68, 1.76, 1), (-3.5, -53.3, 5.65, 1.92, 0), (-5.7, -19.6, 3.27, 2.41, 1), (-3.9, -40.9, 4.67, 2.32, 1), (-1.2, -17.8, 5.80, 2.18, 1), (-5.3, -25.2, 3.76, 1.89, 1), (-3.2, -19.3, 4.64, 2.13, 1), (-4.3, -33.9, 4.36, 2.42, 1), (-6.8, -28.8, 3.18, 2.31, 0), (-4.4, -38.3, 4.21, 1.93, 0), (-9.6, -18.2, 2.67, 2.65, 0), (-1.5, -21.5, 5.77, 1.71, 0), (-0.7, -12.0, 6.72, 2.50, 0), (-9.4, -30.8, 2.80, 2.20, 0), (-1.6, -36.3, 5.92, 1.91, 0), (-4.1, -11.4, 4.48, 1.85, 0), (2.0, -44.0, 8.98, 1.97, 0)),
    'flurry-forest-m': ((-8.5, 27.0, 2.96, 1.82, 0), (-4.4, 6.7, 6.35, 1.78, 1), (-8.5, 12.3, 3.74, 1.89, 0), (2.1, 45.2, 13.88, 2.22, 0), (-4.2, 24.7, 4.28, 1.73, 0), (-5.7, 9.0, 4.85, 1.71, 0), (-2.1, 27.8, 5.22, 1.97, 0), (-9.8, 32.9, 3.25, 1.79, 1), (-0.2, 10.9, 7.09, 1.75, 1), (-0.3, 29.4, 6.60, 2.10, 0), (-8.5, 17.2, 3.26, 1.83, 1), (-7.8, 29.7, 3.52, 1.71, 1), (-8.3, 22.2, 3.10, 1.75, 0), (-6.5, 19.6, 3.51, 2.24, 1), (0.0, 24.3, 7.01, 1.70, 1), (-8.3, 40.0, 5.26, 1.88, 1), (-7.1, 32.5, 4.07, 2.48, 0), (-6.2, 36.3, 4.82, 1.80, 0), (-7.1, 6.9, 4.78, 2.26, 0), (-3.7, 16.6, 4.51, 2.07, 0), (-9.7, 19.5, 2.96, 1.77, 0), (-2.2, 35.6, 6.79, 1.73, 0), (-1.5, 43.8, 10.84, 1.75, 0), (-3.0, 19.2, 4.71, 2.36, 0), (-4.1, 39.6, 6.94, 1.71, 0), (-6.1, 27.6, 3.82, 1.98, 0), (-3.4, 9.8, 5.78, 1.77, 0), (-0.4, 50.0, 14.24, 1.72, 0), (0.8, 8.6, 9.14, 1.75, 0), (-0.7, 37.7, 8.77, 1.82, 0), (-4.5, 29.5, 4.53, 2.43, 0), (-4.0, 2.1, 8.89, 1.95, 0), (-2.1, 33.2, 5.83, 2.32, 0), (0.2, 32.0, 7.15, 2.21, 0)),
    'avalanche-forest-a': ((5.3, 6.5, 3.88, 1.91, 1, 0), (3.9, 7.1, 5.12, 1.83, 0, 0), (4.4, 8.2, 5.08, 1.49, 2, 0), (2.5, 7.7, 6.44, 1.43, 0, 0), (3.6, 10.0, 6.17, 1.28, 2, 0), (1.2, 8.3, 7.61, 1.95, 1, 0), (-0.3, 8.8, 8.54, 2.19, 1, 0), (0.7, 11.0, 8.50, 1.24, 3, 0), (-1.5, 9.7, 9.55, 2.04, 1, 0), (-3.0, 9.9, 10.42, 1.63, 0, 0), (-4.3, 10.7, 11.40, 2.07, 0, 0), (-5.6, 11.5, 12.38, 2.00, 0, 0), (-4.9, 13.0, 12.40, 0.76, 1, 0), (-7.4, 0.5, 8.03, 2.15, 0, 0), (-6.5, 4.6, 9.92, 1.57, 1, 0), (-6.8, 2.2, 8.87, 1.93, 0, 0), (-8.1, 4.8, 10.82, 2.14, 1, 0), (-8.2, 2.9, 9.90, 1.51, 0, 0), (-5.8, 3.3, 9.05, 1.85, 1, 0), (-3.3, -5.4, 3.36, 2.15, 0, 0), (-6.5, -4.2, 4.75, 1.44, 1, 0), (-4.9, -7.7, 2.61, 2.99, 0, 0), (-1.1, -5.4, 3.19, 1.41, 1, 0), (-2.3, -3.7, 4.09, 1.40, 0, 0), (-2.9, -8.4, 1.98, 1.52, 1, 0), (-6.4, -6.1, 3.52, 1.69, 0, 0), (-4.0, -3.6, 4.27, 1.62, 0, 0), (3.5, 1.2, 3.07, 1.74, 0, 0), (1.1, 2.8, 5.13, 1.95, 1, 0), (1.4, -1.0, 3.36, 2.11, 1, 0), (-1.3, 1.8, 6.08, 2.79, 1, 0), (0.0, 1.0, 4.97, 2.13, 1, 0), (-0.2, -0.7, 4.53, 2.12, 0, 0), (3.1, 2.9, 4.08, 1.67, 0, 0), (2.1, 0.6, 3.63, 2.07, 1, 0), (-1.9, 5.6, 8.01, 2.18, 1, 0), (-0.1, 5.6, 7.10, 1.85, 0, 0), (-0.4, 3.1, 6.17, 1.81, 0, 0), (1.8, 4.8, 5.66, 2.09, 1, 0), (-1.0, 7.1, 8.21, 1.78, 0, 0), (1.6, 6.6, 6.59, 1.60, 0, 0), (-1.7, 3.6, 7.11, 2.05, 1, 0), (3.2, -9.2, 0.40, 1.49, 1, 0), (5.2, -8.4, 0.22, 1.63, 0, 0), (4.5, -13.0, 0.51, 1.88, 0, 0), (3.6, -10.9, 0.42, 1.81, 1, 0), (5.5, -11.4, 0.29, 2.19, 1, 0), (1.6, -10.0, 0.85, 1.73, 0, 0), (2.4, -12.7, 0.87, 1.85, 0, 0), (3.6, -7.5, 0.32, 1.86, 0, 0), (1.2, -11.4, 1.08, 1.59, 0, 0), (6.0, -9.6, 0.20, 1.90, 1, 0), (1.3, -8.3, 1.64, 2.70, 1, 0), (4.8, -0.8, 1.46, 1.59, 1, 0), (2.9, -2.9, 1.92, 2.73, 0, 0), (4.8, -6.0, 0.18, 1.44, 0, 0), (4.7, -4.4, 0.36, 1.56, 1, 0), (1.3, -3.8, 2.74, 1.72, 0, 0), (4.6, -2.5, 0.89, 2.12, 1, 0), (2.8, -5.8, 1.30, 1.54, 1, 0), (3.3, -1.1, 2.14, 2.06, 0, 0), (0.3, -2.3, 3.81, 1.87, 1, 0), (-7.7, 7.4, 11.71, 1.99, 0, 0), (-4.0, 0.8, 6.83, 1.67, 0, 0), (-5.1, 7.2, 10.36, 1.83, 1, 0), (-1.4, -10.6, 1.90, 2.10, 0, 0), (-6.7, 9.4, 12.06, 1.57, 0, 0), (-5.6, -1.8, 5.85, 1.71, 0, 0)),
    'avalanche-forest-b': ((0.7, -26.3, 11.29, 1.92, 0, 0), (8.4, 6.0, 0.08, 0.91, 0, 1), (7.2, 7.0, 0.72, 1.41, 0, 1), (6.2, 8.0, 1.53, 2.11, 1, 1), (5.1, 9.1, 2.46, 2.79, 1, 1), (6.3, 10.3, 1.83, 1.15, 2, 1), (4.1, 10.2, 3.39, 1.99, 0, 0), (5.0, 11.2, 2.86, 1.36, 3, 1), (2.9, 11.1, 4.55, 1.67, 0, 0), (1.8, 12.2, 5.60, 1.44, 0, 0), (0.7, 13.2, 6.84, 2.62, 0, 0), (-0.5, 14.1, 8.03, 2.10, 0, 0), (0.9, 15.6, 8.13, 1.41, 2, 0), (-1.5, 15.2, 8.79, 1.55, 1, 0), (0.9, 17.7, 9.55, 1.42, 2, 0), (-2.5, 16.4, 9.75, 1.76, 0, 0), (-3.6, 17.4, 10.72, 2.11, 0, 0), (-4.7, 18.4, 11.45, 1.48, 0, 0), (-2.9, 22.4, 12.96, 0.82, 0, 0), (-5.7, -12.5, 8.09, 2.11, 1, 0), (-3.5, -10.0, 6.44, 1.96, 1, 0), (-0.8, -13.1, 4.10, 1.89, 1, 0), (-1.4, -15.5, 5.69, 1.88, 0, 0), (-4.3, -15.7, 6.84, 1.79, 0, 0), (-5.2, -14.3, 7.41, 1.64, 1, 0), (0.0, -12.0, 3.38, 1.45, 0, 0), (-2.4, -11.2, 5.06, 2.13, 1, 0), (5.2, -0.4, 3.15, 2.06, 0, 1), (7.0, -0.6, 1.78, 1.12, 0, 1), (7.4, -4.0, 0.20, 0.94, 0, 1), (3.9, -5.6, 1.96, 2.91, 1, 1), (6.3, -2.3, 1.15, 2.02, 0, 1), (1.9, -4.4, 3.58, 1.83, 0, 0), (4.7, -3.7, 1.82, 1.51, 1, 1), (2.9, -0.7, 4.55, 1.91, 1, 1), (5.7, -4.8, 1.03, 2.08, 0, 1), (1.6, -2.3, 4.41, 2.78, 0, 0), (-7.3, 7.0, 12.08, 1.76, 0, 0), (-6.0, 9.1, 10.78, 2.12, 1, 0), (-3.9, 5.6, 9.57, 1.85, 1, 0), (-4.2, 4.1, 10.02, 1.85, 0, 0), (-2.7, 6.5, 8.60, 1.90, 0, 0), (-5.0, 7.1, 10.21, 1.88, 0, 0), (-4.5, 8.6, 9.68, 2.06, 0, 0), (-6.4, 4.4, 11.68, 1.56, 0, 0), (-2.6, 8.3, 8.33, 1.45, 0, 0), (-6.3, -7.4, 9.70, 1.40, 0, 0), (-3.4, -7.5, 6.86, 2.14, 0, 0), (-4.2, -5.5, 8.26, 1.80, 1, 0), (-7.9, -4.9, 11.77, 1.68, 0, 0), (-4.0, -3.0, 8.90, 1.52, 0, 0), (-7.9, -8.2, 11.09, 2.02, 0, 0), (-8.9, -6.6, 12.33, 2.12, 0, 0), (2.3, 3.4, 4.33, 1.83, 0, 0), (3.6, 5.2, 3.23, 1.70, 0, 1), (1.3, 8.9, 5.19, 1.82, 1, 0), (5.3, 3.9, 2.04, 1.78, 0, 1), (-0.2, 4.6, 6.51, 1.65, 1, 0), (2.1, 5.2, 4.45, 1.71, 0, 0), (0.7, 7.2, 5.56, 2.93, 1, 0), (6.1, -8.7, 0.57, 2.80, 1, 1), (7.0, -10.1, 0.54, 1.46, 0, 1), (8.6, -11.0, 0.24, 1.55, 1, 1), (8.8, -9.4, -0.00, 1.13, 0, 1), (5.2, -10.8, 1.43, 1.74, 0, 1), (5.8, -12.4, 1.62, 1.80, 0, 1), (7.7, -7.3, 0.01, 1.04, 0, 1), (10.0, -10.6, -0.00, 1.02, 0, 1), (-8.8, -0.7, 12.90, 1.85, 0, 0), (-9.6, 1.3, 13.76, 1.89, 0, 0), (-9.8, -1.9, 13.49, 1.44, 0, 0), (-10.4, -3.2, 13.74, 1.76, 1, 0), (-10.5, -0.5, 14.14, 2.13, 0, 0), (-1.0, 0.6, 6.97, 1.70, 0, 0), (-2.7, 1.9, 8.88, 1.58, 0, 0), (0.4, 2.8, 6.01, 1.49, 0, 0), (0.9, 0.5, 5.46, 1.81, 1, 0), (-2.9, -1.5, 8.41, 1.71, 1, 0), (-0.1, -2.4, 5.61, 1.63, 0, 0), (2.0, 2.0, 4.64, 1.48, 0, 0), (-2.7, 0.3, 8.50, 1.93, 0, 0), (-1.2, 2.5, 7.54, 2.19, 1, 0), (-3.6, -20.4, 9.28, 1.54, 0, 0), (-1.0, -5.2, 5.62, 1.53, 0, 0), (0.8, -7.7, 3.36, 1.66, 1, 0), (-6.2, 15.9, 10.83, 1.89, 0, 0), (-6.8, -1.9, 11.35, 1.40, 0, 0), (-6.1, 1.0, 11.22, 1.46, 0, 0), (9.5, -7.1, -0.00, 1.24, 1, 1)),
    'avalanche-forest-c': ((11.8, -3.8, 0.03, 1.02, 0, 1), (12.0, -5.8, 0.36, 1.11, 3, 1), (10.3, -3.8, 2.23, 1.60, 1, 1), (10.6, -7.7, 1.87, 1.35, 2, 1), (8.9, -4.2, 4.53, 2.14, 1, 1), (7.3, -4.0, 7.10, 2.62, 0, 0), (5.9, -4.3, 8.25, 1.86, 0, 0), (4.3, -4.2, 9.62, 1.96, 1, 0), (2.9, -4.4, 10.67, 1.94, 1, 0), (3.0, -6.9, 9.08, 1.39, 3, 0), (1.4, -4.8, 11.59, 2.04, 0, 0), (1.6, -7.9, 10.04, 1.41, 2, 0), (-0.1, -4.6, 12.76, 2.05, 1, 0), (0.1, -7.7, 11.00, 1.13, 2, 0), (-1.6, -5.0, 13.45, 1.74, 0, 0), (-3.1, -5.2, 14.38, 1.49, 0, 0), (-2.9, -8.3, 12.68, 0.80, 0, 0), (-4.6, -5.1, 15.18, 1.52, 0, 0), (-6.1, -5.2, 15.64, 1.89, 0, 0), (-7.6, -5.2, 16.46, 1.63, 0, 0), (0.9, 7.7, 18.19, 1.49, 0, 0), (-0.5, 7.2, 18.53, 1.59, 1, 0), (-0.9, 11.5, 19.04, 0.81, 0, 0), (-2.1, 7.4, 18.88, 1.60, 0, 0), (-3.6, 7.2, 19.15, 1.50, 0, 0), (-3.8, 10.0, 19.77, 0.80, 1, 0), (-5.1, 7.2, 19.61, 2.10, 1, 0), (-6.5, 6.8, 20.06, 2.05, 0, 0), (-2.9, -2.8, 15.71, 1.53, 1, 0), (-6.8, -3.0, 16.99, 1.76, 0, 0), (-5.0, -3.2, 16.24, 1.99, 0, 0), (-6.0, -2.0, 17.19, 1.76, 1, 0), (-6.4, 4.4, 19.48, 2.15, 1, 0), (-7.7, 4.6, 19.74, 1.56, 0, 0), (-4.4, 5.3, 19.00, 2.85, 0, 0), (0.8, 4.2, 17.52, 1.48, 0, 0), (-2.9, 5.4, 18.62, 1.64, 0, 0), (-0.6, 3.1, 17.43, 2.61, 1, 0), (-4.6, 3.3, 18.63, 1.79, 0, 0), (-2.3, 2.6, 17.93, 1.53, 0, 0), (-4.3, 0.9, 18.25, 2.13, 0, 0), (-1.0, 5.5, 18.22, 1.77, 0, 0), (0.5, 1.8, 16.85, 1.54, 0, 0), (-2.7, -0.3, 16.88, 2.09, 0, 0), (11.0, 1.2, 0.95, 0.89, 1, 1), (10.5, -1.4, 2.52, 1.76, 0, 1), (0.8, -0.7, 15.36, 2.04, 0, 0)),
    'avalanche-forest-d': ((0.3, -12.0, 18.80, 1.81, 0, 0), (-1.0, -12.9, 19.49, 1.65, 1, 0), (-2.4, -13.3, 19.88, 2.09, 0, 0), (-3.9, -13.6, 21.24, 2.00, 1, 0), (-3.1, -15.7, 20.10, 0.84, 0, 0), (-5.2, -14.4, 22.36, 1.91, 0, 0), (-4.7, -15.8, 21.43, 0.71, 1, 0), (6.1, -2.1, 8.51, 1.64, 1, 0), (3.6, -3.1, 11.79, 2.67, 0, 0), (5.9, -0.8, 7.75, 2.09, 1, 0), (8.6, 0.8, 3.36, 1.46, 0, 1), (7.5, -1.3, 5.65, 1.66, 1, 1), (3.4, -0.7, 10.51, 1.60, 0, 0), (4.3, 0.4, 8.65, 1.95, 0, 0), (6.1, 0.6, 6.57, 1.62, 1, 0), (5.7, 2.2, 6.13, 1.84, 1, 0), (-6.2, -12.6, 23.86, 1.44, 0, 0), (-3.7, -8.1, 21.18, 1.67, 0, 0), (-3.2, -11.4, 21.09, 1.93, 0, 0), (-3.0, -9.4, 21.30, 1.42, 1, 0), (-4.8, -9.8, 22.82, 2.68, 0, 0), (-5.4, -7.5, 22.15, 2.15, 0, 0), (-6.4, -3.1, 21.16, 2.98, 1, 0), (-6.6, 0.3, 19.51, 1.47, 1, 0), (-4.9, 0.7, 17.88, 2.62, 0, 0), (-8.4, 0.2, 20.95, 2.19, 0, 0), (-5.4, -4.6, 20.84, 1.62, 1, 0), (-4.1, -2.0, 18.83, 2.14, 0, 0), (-7.7, -1.6, 21.60, 2.82, 0, 0), (7.6, 2.0, 4.76, 2.83, 0, 1), (9.1, 3.4, 3.36, 1.43, 0, 1), (7.4, 5.5, 5.17, 1.73, 0, 0), (5.0, 3.4, 6.86, 2.20, 1, 0), (6.0, 6.4, 6.28, 1.68, 0, 0), (4.8, 5.1, 7.02, 1.90, 1, 0), (7.0, 3.9, 5.36, 1.66, 0, 0), (3.9, 6.4, 7.72, 1.90, 0, 0), (2.7, 5.0, 9.28, 1.93, 0, 0), (2.4, 6.8, 9.35, 2.11, 0, 0), (5.8, 8.0, 6.45, 1.99, 1, 0), (3.5, 3.7, 8.55, 2.90, 0, 0), (4.2, 8.1, 7.58, 1.98, 0, 0), (-2.4, 11.0, 11.88, 1.78, 1, 0), (-3.4, 13.3, 12.81, 1.67, 0, 0), (-4.5, 10.8, 13.16, 1.81, 1, 0), (-6.0, 12.2, 13.40, 2.17, 0, 0), (-4.8, 9.4, 13.13, 1.49, 1, 0), (-4.5, 12.4, 13.35, 1.49, 1, 0), (-1.7, 0.1, 15.37, 1.97, 0, 0), (-0.9, 13.3, 11.27, 2.09, 1, 0), (-5.3, 3.8, 16.08, 1.90, 1, 0), (-1.5, -2.1, 16.43, 1.79, 1, 0), (3.1, 13.5, 8.68, 2.03, 0, 0)),
    'avalanche-forest-e': ((-6.4, -5.8, 11.28, 2.05, 0, 0), (-2.9, -10.2, 11.08, 1.40, 0, 0), (-6.2, -8.0, 12.37, 2.17, 0, 0), (-2.9, -8.6, 10.59, 1.96, 0, 0), (-0.9, -7.3, 8.93, 1.68, 1, 0), (-5.3, -10.0, 12.41, 2.01, 0, 0), (-3.4, -6.1, 10.01, 2.10, 1, 0), (-3.3, -3.3, 9.07, 1.45, 1, 0), (-6.0, -3.6, 9.98, 1.59, 0, 0), (-2.4, -4.6, 8.92, 1.58, 1, 0), (-4.5, -8.7, 11.56, 1.87, 0, 0), (9.4, 0.5, 1.14, 1.59, 0, 1), (6.4, 2.0, 1.94, 1.87, 1, 1), (6.5, 0.2, 2.30, 2.11, 0, 1), (6.0, 4.1, 1.64, 2.68, 1, 0), (4.7, -0.5, 3.28, 1.99, 1, 0), (3.5, 2.4, 3.12, 1.82, 0, 0), (3.5, 0.6, 3.59, 1.60, 0, 0), (7.3, 3.3, 1.37, 1.53, 1, 1), (9.9, 1.8, 0.70, 1.40, 0, 1), (2.0, -0.2, 4.72, 1.68, 1, 0), (0.6, -0.3, 5.63, 2.09, 0, 0), (-1.1, -0.8, 6.86, 1.59, 1, 0), (2.1, 2.5, 3.81, 2.11, 0, 0), (-0.8, 1.2, 6.06, 1.56, 0, 0), (1.3, -2.0, 5.73, 2.13, 1, 0), (0.5, 2.0, 4.98, 1.43, 0, 0), (-2.9, 4.5, 4.85, 1.78, 0, 0), (1.3, 4.1, 3.80, 2.06, 1, 0), (-3.9, 2.8, 5.97, 1.45, 1, 0), (-2.5, 2.6, 5.77, 2.11, 0, 0), (-0.4, 5.8, 3.51, 1.61, 0, 0), (-3.7, 1.3, 6.74, 2.09, 1, 0), (-0.2, -2.0, 6.68, 1.87, 1, 0), (-1.4, 3.9, 4.77, 1.84, 0, 0), (-3.1, -0.9, 7.76, 2.14, 0, 0), (0.9, 5.4, 3.37, 1.50, 0, 0), (-5.3, 8.5, 3.32, 1.76, 1, 0), (3.9, 9.9, 1.30, 1.89, 0, 0), (8.5, 7.4, 0.41, 1.64, 0, 1), (-10.0, 8.5, 4.71, 1.65, 1, 0)),
    'avalanche-forest-f': ((-9.3, 12.6, 0.18, 1.68, 0, 1), (-7.7, 12.6, 0.33, 1.75, 0, 1), (-6.4, 11.9, 0.41, 1.40, 0, 1), (-4.9, 11.5, 0.52, 1.82, 1, 1), (-3.4, 11.2, 0.65, 1.59, 0, 0), (-4.1, 5.7, 0.49, 1.19, 2, 1), (-4.6, 2.4, 0.24, 1.04, 1, 1), (-2.1, 10.4, 1.07, 1.74, 0, 0), (-3.9, 7.1, 0.54, 1.39, 3, 1), (-3.2, 1.9, 1.31, 2.06, 0, 1), (-0.6, 10.1, 1.88, 1.42, 1, 0), (-1.3, 7.9, 1.97, 1.29, 3, 0), (-1.6, 1.8, 2.94, 1.82, 0, 1), (0.8, 9.5, 3.15, 2.11, 0, 0), (0.1, 8.1, 2.93, 1.33, 2, 0), (-0.2, 1.3, 4.70, 2.14, 0, 1), (2.2, 9.2, 4.99, 1.51, 1, 0), (0.6, 3.2, 5.15, 1.13, 3, 0), (1.2, 0.6, 6.52, 1.74, 1, 0), (3.7, 8.9, 7.20, 1.57, 1, 0), (3.1, 4.1, 7.79, 1.29, 2, 0), (2.6, 0.1, 8.37, 2.04, 0, 0), (5.1, 8.4, 9.27, 1.99, 0, 0), (3.7, 3.3, 8.82, 1.06, 2, 0), (4.0, -0.4, 10.24, 2.11, 1, 0), (6.6, 8.0, 10.50, 2.06, 0, 0), (5.9, 2.6, 11.66, 0.77, 0, 0), (5.4, -0.8, 12.21, 1.41, 0, 0), (8.0, 7.6, 11.80, 1.78, 0, 0), (7.0, -0.9, 13.93, 1.55, 0, 0), (9.4, 7.0, 13.17, 1.64, 0, 0), (8.3, -1.7, 16.36, 1.81, 0, 0), (10.8, 6.6, 14.39, 1.80, 1, 0), (9.8, -2.0, 18.21, 1.84, 1, 0), (12.3, 6.4, 15.54, 2.07, 0, 0), (11.5, 2.9, 17.26, 0.97, 0, 0), (11.2, -2.4, 19.44, 2.12, 1, 0), (12.7, -2.6, 20.61, 1.51, 1, 0), (1.2, 11.7, 3.87, 2.19, 1, 0), (4.9, 9.8, 7.99, 2.95, 0, 0), (2.8, 11.3, 5.39, 1.78, 1, 0), (3.1, 13.0, 4.19, 1.76, 1, 0), (-0.5, 11.7, 1.92, 2.19, 1, 0), (-6.8, -13.6, 1.04, 1.72, 0, 1), (-5.2, -13.3, 2.22, 1.62, 1, 1), (-4.0, -17.9, 4.70, 1.98, 0, 0), (-7.0, -16.5, 1.94, 1.49, 0, 1), (-4.4, -15.1, 3.59, 1.63, 1, 1), (-5.2, -19.4, 4.21, 1.70, 1, 0), (-7.3, -19.7, 2.68, 1.87, 0, 1), (-7.8, -18.0, 1.69, 2.19, 0, 1), (-5.1, -16.7, 3.62, 3.00, 0, 1), (-7.5, -15.2, 1.10, 2.12, 0, 1), (-3.6, -16.2, 4.66, 1.76, 0, 0), (-5.8, -15.0, 2.42, 1.54, 0, 1), (3.3, -17.8, 10.08, 1.99, 0, 0), (1.3, -20.0, 8.75, 2.94, 0, 0), (-0.4, -17.2, 7.08, 1.59, 0, 0), (1.7, -17.3, 8.61, 2.04, 0, 0), (1.8, -15.4, 8.46, 1.53, 0, 0), (0.6, -18.7, 7.99, 1.73, 0, 0), (4.1, -16.7, 10.57, 2.12, 0, 0), (3.1, -19.6, 10.18, 2.05, 0, 0), (-7.7, 18.7, 1.17, 1.71, 0, 0), (-3.7, 16.2, 1.28, 1.80, 1, 0), (-3.6, 19.5, 1.45, 1.57, 1, 0), (-2.1, 18.0, 1.42, 2.02, 0, 0), (-5.1, 17.9, 1.32, 1.94, 0, 0), (-7.9, 16.8, 0.90, 1.62, 0, 0), (-5.5, 19.4, 1.38, 2.13, 1, 0), (-6.6, 15.3, 0.83, 1.54, 1, 0), (-6.0, 16.8, 1.11, 1.71, 0, 0), (-3.2, -2.8, 1.73, 1.86, 0, 1), (-2.7, -0.7, 1.93, 1.82, 1, 1), (-3.9, -4.4, 1.30, 1.79, 0, 1), (-1.5, -3.6, 3.95, 1.82, 1, 1), (-1.4, -2.0, 3.72, 2.12, 0, 1), (-4.3, -1.0, 0.28, 1.17, 0, 1), (1.2, -10.7, 7.72, 1.71, 1, 0), (-1.4, -11.2, 5.32, 2.90, 1, 0), (-2.8, -14.5, 4.69, 2.76, 1, 0), (4.2, -12.9, 10.97, 2.01, 0, 0), (-3.8, -13.3, 3.46, 2.08, 0, 1), (0.4, -12.2, 6.92, 2.13, 0, 0), (-0.9, -14.1, 5.95, 1.85, 0, 0), (3.4, -11.5, 10.30, 1.50, 0, 0), (9.1, 11.0, 9.68, 1.90, 1, 0), (9.6, -5.5, 18.73, 1.62, 0, 0), (4.0, 16.1, 4.32, 2.14, 0, 0), (5.7, -10.0, 13.15, 2.09, 0, 0), (7.8, 14.1, 6.44, 1.61, 0, 0), (-8.4, -11.7, 0.23, 1.50, 1, 1), (-6.9, -9.5, 0.22, 1.18, 0, 1), (-4.4, 0.7, 0.28, 1.33, 1, 1)),
    'avalanche-forest-g': ((-3.9, 9.8, 3.37, 1.53, 0, 0), (-5.2, 4.3, 2.73, 1.46, 1, 1), (-5.7, 8.7, 2.16, 2.01, 0, 1), (-2.1, 5.4, 4.88, 1.70, 0, 0), (-1.1, 8.9, 5.24, 1.67, 0, 0), (-4.1, 8.0, 3.29, 1.40, 0, 1), (-0.7, 7.0, 5.66, 2.04, 0, 0), (-2.3, 9.8, 4.48, 1.96, 0, 0), (-0.4, 5.0, 6.10, 1.80, 1, 0), (7.3, 0.9, 11.51, 1.41, 0, 0), (7.3, 3.3, 11.29, 1.82, 0, 0), (9.5, 2.7, 12.82, 2.03, 0, 0), (9.7, 0.1, 12.92, 2.06, 1, 0), (8.4, 5.0, 11.96, 1.42, 0, 0), (5.3, 1.4, 10.18, 1.52, 0, 0), (6.0, 4.0, 10.32, 1.81, 0, 0), (7.8, -0.9, 11.42, 1.91, 0, 0), (0.4, -15.2, 1.63, 2.17, 0, 0), (-3.6, -11.2, 1.49, 1.57, 0, 0), (-1.0, -9.6, 3.51, 1.78, 0, 0), (-2.9, -15.3, 0.86, 1.61, 0, 0), (-0.9, -12.8, 2.06, 1.78, 0, 0), (-1.4, -14.7, 1.05, 1.88, 1, 0), (1.5, -12.7, 3.29, 1.66, 1, 0), (8.7, 1.4, 12.38, 2.10, 1, 0), (8.7, 6.3, 12.11, 1.79, 0, 0), (6.9, 5.5, 10.93, 1.41, 1, 0), (10.0, 5.0, 12.93, 1.61, 1, 0), (4.0, -1.7, 8.83, 1.68, 0, 0), (-2.3, 3.1, 5.02, 1.46, 1, 0), (2.6, 2.2, 8.40, 1.52, 0, 0), (-1.1, -0.6, 5.67, 1.67, 1, 0), (-0.2, 2.1, 6.55, 1.81, 0, 0), (2.2, -2.4, 7.49, 1.79, 0, 0), (-1.8, 1.1, 5.31, 2.03, 1, 0), (0.8, -1.0, 7.03, 2.11, 0, 0), (-6.2, 11.2, 1.95, 1.94, 0, 1), (-6.9, 6.8, 1.51, 1.68, 1, 1), (-7.7, 9.6, 0.87, 1.50, 1, 1), (-7.0, 4.8, 1.33, 1.90, 1, 1), (-8.8, 7.6, 0.37, 1.18, 0, 1), (-5.2, 6.4, 2.72, 2.77, 0, 1), (-8.3, 11.2, 0.57, 2.06, 0, 1), (-1.5, -18.3, 0.90, 1.88, 0, 0), (1.9, -18.6, 1.20, 1.43, 0, 0), (1.5, -16.2, 1.73, 1.89, 1, 0), (-3.3, -19.0, 0.59, 2.01, 0, 0), (0.4, -17.6, 1.19, 1.83, 0, 0), (-2.4, -16.6, 0.88, 1.70, 1, 0), (0.9, 10.5, 6.06, 2.07, 1, 0), (-6.3, 19.9, 1.67, 1.41, 0, 0), (3.2, 12.4, 7.09, 1.61, 0, 0), (5.2, 7.5, 9.61, 2.12, 1, 0), (2.8, -6.9, 6.40, 1.93, 0, 0), (-7.4, 0.0, 0.76, 1.31, 0, 1), (-7.7, 2.9, 0.66, 0.98, 1, 1)),
    'avalanche-forest-h': ((-1.1, -0.1, 0.26, 1.73, 1, 0), (-2.0, -2.7, 0.31, 1.90, 0, 0), (-0.1, 1.9, 0.22, 1.72, 1, 0), (-2.2, 1.6, 0.21, 1.84, 1, 0), (0.7, -0.2, 0.28, 2.10, 0, 0), (-3.6, -0.8, 0.25, 2.11, 0, 0), (2.2, 1.5, 0.24, 1.73, 0, 1), (2.2, -2.2, 0.33, 1.93, 0, 1), (3.0, -1.0, 0.31, 2.13, 0, 1), (-2.1, 3.0, 0.18, 2.81, 1, 0), (0.3, -3.1, 0.35, 1.99, 1, 0), (-5.6, -2.2, 0.24, 1.51, 0, 0), (-4.1, -4.8, 0.25, 1.49, 1, 0), (-3.9, -2.5, 0.28, 1.65, 0, 0), (-4.2, -6.8, 0.22, 1.48, 0, 0), (-5.3, -4.0, 0.23, 2.06, 0, 0), (-2.5, -4.2, 0.29, 2.10, 0, 0), (-2.6, -5.6, 0.27, 1.93, 0, 0), (0.8, -7.0, 0.31, 1.59, 1, 0), (-6.0, 5.0, 0.14, 1.52, 1, 1), (5.5, -0.0, 0.30, 1.36, 0, 1), (5.6, 2.3, 0.26, 1.14, 0, 1), (6.7, 4.6, 0.25, 0.97, 0, 1), (5.4, 5.7, 0.23, 1.24, 1, 1), (6.7, 7.9, 0.22, 1.34, 0, 1), (5.8, 10.1, 0.22, 0.97, 0, 1)),
    'glacier-forest-a': ((3.0, 6.5, 3.27, 2.00), (-0.7, -3.5, 5.05, 1.67), (-5.9, -0.4, 7.72, 2.09), (-0.6, 3.1, 5.61, 1.75), (-4.6, -9.8, 5.91, 1.93), (3.2, 1.5, 3.33, 2.13), (-1.4, 8.5, 5.76, 1.58), (6.9, 17.2, 0.56, 2.01), (2.3, -8.4, 2.79, 1.63), (-0.9, 12.5, 4.91, 2.07), (-4.6, 12.0, 6.33, 1.68), (2.0, 15.8, 2.41, 1.96), (7.8, -7.5, 0.58, 1.46), (-1.2, -10.5, 4.35, 1.44), (6.9, -12.1, 0.64, 1.47), (7.9, -2.3, 0.75, 2.06), (0.8, -9.0, 3.59, 2.14), (4.9, 1.4, 2.29, 2.08), (-1.3, -5.3, 5.13, 1.83), (0.8, -5.7, 3.91, 1.82), (1.5, 7.8, 4.13, 2.11), (-5.5, -3.1, 7.27, 2.10), (4.0, -9.4, 1.68, 1.91), (2.3, -2.9, 3.39, 2.14), (3.6, 8.7, 2.89, 1.36), (-5.9, 13.6, 6.28, 2.12), (5.6, 15.9, 0.86, 1.46), (5.3, 11.3, 1.91, 1.94), (-3.6, -6.9, 5.71, 1.93), (-3.7, -15.5, 3.82, 1.48), (4.0, -11.2, 1.63, 1.59), (-2.6, 9.7, 6.05, 2.12), (0.5, 14.2, 3.65, 1.72), (6.9, -9.3, 0.60, 1.41), (6.6, 0.3, 1.38, 1.99), (7.6, 7.9, 1.10, 1.77), (5.6, 3.3, 1.88, 1.60), (0.2, 10.3, 4.69, 2.07), (6.3, -3.7, 1.26, 1.91), (-4.6, -5.5, 6.55, 1.99)),
    'avalanche-forest-i': ((-11.0, 15.3, 13.77, 2.62, 0, 0), (-8.6, 12.2, 17.03, 2.74, 0, 0), (-10.1, 13.9, 15.40, 1.64, 0, 0), (-6.3, 17.0, 11.97, 1.55, 0, 0), (-4.0, 15.9, 10.65, 2.01, 0, 0), (-7.0, 19.8, 13.63, 1.57, 1, 0), (-3.5, 18.0, 11.23, 2.12, 0, 0), (-8.5, 19.5, 14.26, 2.09, 1, 0), (-13.7, 15.8, 15.18, 1.70, 1, 0), (-10.2, 17.9, 13.48, 2.09, 0, 0), (-11.2, 16.7, 12.81, 2.05, 0, 0), (-16.4, 17.1, 15.57, 1.50, 0, 0), (-13.5, 18.3, 14.18, 2.85, 0, 0), (-21.2, 18.8, 18.02, 2.06, 1, 0), (11.3, -5.2, 13.12, 2.08, 0, 0), (12.4, -8.8, 10.07, 2.06, 1, 0), (10.0, -9.6, 12.63, 1.78, 1, 0), (10.1, -4.3, 14.57, 1.74, 0, 0), (13.9, -6.7, 10.19, 1.95, 0, 0), (9.6, -11.2, 12.27, 1.91, 0, 0), (9.7, -7.2, 13.90, 1.66, 0, 0), (7.2, -10.8, 15.98, 1.97, 0, 0), (-3.9, -24.5, 15.86, 1.95, 0, 0), (-5.1, -23.4, 17.80, 2.09, 1, 0), (-1.5, -24.3, 13.34, 2.85, 0, 0), (-0.8, -21.7, 15.63, 2.95, 1, 0), (-2.4, -20.9, 18.08, 2.07, 1, 0), (10.9, -21.5, 3.60, 2.01, 1, 2), (5.0, -30.8, 5.77, 1.42, 0, 2), (7.8, 8.4, 10.02, 1.86, 0, 0), (4.9, 5.3, 14.99, 2.13, 0, 0), (16.3, -17.6, 2.89, 1.98, 0, 2), (5.4, 12.3, 7.57, 1.42, 0, 0), (9.4, -19.3, 6.25, 1.69, 1, 2)),
    'avalanche-forest-j': ((9.2, -9.5, 5.60, 2.06, 1, 2), (7.7, -9.9, 6.62, 2.14, 0, 2), (6.4, -10.6, 7.70, 1.87, 0, 0), (5.0, -11.2, 8.91, 2.03, 0, 0), (10.0, -25.0, 10.29, 1.78, 0, 0), (1.0, -13.4, 12.71, 1.46, 0, 0), (7.4, -26.4, 12.92, 1.75, 0, 0), (6.0, -26.9, 14.26, 2.16, 1, 0), (-1.7, -14.5, 15.12, 1.40, 1, 0), (4.6, -27.6, 15.54, 1.92, 1, 0), (-3.0, -15.3, 16.44, 1.54, 0, 0), (-22.0, 16.0, 13.67, 1.92, 0, 0), (-23.7, 16.5, 13.56, 1.52, 1, 0), (-23.6, 14.2, 13.19, 2.15, 0, 0), (-25.6, 14.8, 13.76, 1.85, 0, 0), (-5.7, 17.8, 17.47, 1.86, 0, 0), (-3.4, 16.8, 16.62, 1.98, 0, 0), (7.1, 2.8, 5.35, 2.05, 0, 2), (2.5, 1.5, 6.89, 1.49, 0, 2), (4.2, 7.6, 9.13, 1.99, 0, 0), (4.0, 4.6, 6.42, 1.88, 1, 2), (0.6, 4.7, 8.02, 1.83, 0, 0), (1.9, 3.9, 7.51, 1.87, 0, 0), (2.2, 5.5, 7.97, 2.08, 0, 0), (5.7, 1.8, 5.32, 2.12, 0, 2), (6.7, 7.4, 8.34, 1.63, 0, 0), (5.9, 5.5, 6.96, 2.00, 1, 2), (8.0, 5.2, 6.60, 1.46, 0, 2), (1.0, 6.7, 8.97, 1.81, 0, 0), (-4.6, -10.7, 14.87, 2.01, 1, 0), (-6.3, -10.5, 15.86, 1.76, 0, 0), (-6.3, -8.8, 14.94, 2.65, 0, 0), (-6.4, 6.6, 10.47, 1.85, 0, 0), (-2.8, 6.9, 9.87, 1.55, 0, 0), (-4.8, 6.4, 10.00, 1.50, 1, 0), (-3.6, 9.4, 11.56, 1.60, 1, 0), (-5.2, 4.3, 9.11, 1.44, 1, 0), (-6.8, 5.2, 9.67, 2.06, 0, 0), (-25.6, 4.8, 17.00, 1.44, 0, 0), (-27.5, 9.4, 14.60, 2.62, 1, 0), (-27.5, 7.6, 15.77, 1.88, 0, 0), (-26.4, 6.6, 16.05, 1.79, 0, 0), (-13.7, 16.2, 15.96, 2.13, 0, 0), (-18.3, 13.7, 13.04, 1.55, 0, 0), (-16.4, 12.8, 12.88, 2.00, 0, 0), (-19.8, 15.1, 13.58, 2.13, 0, 0), (-17.3, 17.6, 16.05, 1.73, 0, 0), (3.9, 15.6, 14.99, 1.97, 0, 0), (5.8, 14.9, 14.06, 1.56, 0, 0), (3.1, 12.6, 12.87, 2.69, 1, 0), (5.2, 13.0, 12.80, 1.91, 1, 0), (4.1, 13.7, 13.50, 1.75, 0, 0), (5.7, 16.4, 15.08, 1.86, 0, 0), (18.6, -12.7, 1.86, 1.71, 0, 2), (14.3, -13.7, 4.53, 1.63, 0, 2), (14.8, -9.8, 2.54, 1.59, 0, 2), (17.0, -11.6, 2.23, 2.06, 0, 2), (16.8, -9.3, 1.16, 1.41, 1, 2), (15.5, -13.0, 3.70, 1.94, 0, 2), (15.9, -14.4, 3.69, 1.99, 0, 2), (12.7, -11.7, 4.68, 1.70, 1, 2), (18.0, -13.9, 2.40, 1.47, 0, 2), (15.2, -11.5, 3.18, 1.64, 1, 2), (18.1, -10.8, 1.20, 1.70, 1, 2), (13.6, -10.6, 3.61, 1.93, 0, 2), (8.4, -27.7, 12.19, 1.63, 0, 0), (-4.0, 12.0, 13.43, 1.72, 1, 0), (-3.7, 13.8, 14.65, 1.89, 0, 0), (-6.2, 15.0, 15.58, 1.96, 0, 0), (-5.4, 16.2, 16.31, 2.13, 0, 0), (-21.2, 5.5, 15.10, 2.97, 1, 0), (14.8, 2.0, 3.65, 1.84, 0, 2), (-1.6, 11.7, 12.87, 1.75, 1, 0), (11.8, -7.6, 3.19, 1.71, 0, 2), (7.4, -6.9, 5.38, 2.14, 0, 2), (11.0, 11.8, 9.24, 1.97, 0, 0), (1.0, -8.0, 9.66, 1.59, 0, 0)),
    'avalanche-forest-k': ((-6.2, 19.5, 16.86, 1.79, 0, 0), (-1.4, -8.7, 16.81, 2.08, 1, 0), (-3.0, -8.5, 18.18, 2.18, 1, 0), (0.6, 16.3, 12.61, 2.17, 1, 0), (-1.7, 17.8, 14.16, 2.16, 1, 0), (1.8, 19.4, 11.05, 1.58, 0, 0), (1.9, -11.0, 12.87, 1.93, 0, 0), (-2.5, -10.8, 17.82, 1.58, 0, 0), (-0.3, 4.5, 14.96, 1.89, 0, 0), (1.5, 3.4, 13.68, 2.17, 1, 0), (-1.2, 6.4, 15.55, 1.77, 0, 0), (0.7, 0.6, 13.93, 1.66, 1, 0), (-1.2, 1.3, 16.17, 2.09, 0, 0), (-0.9, -17.3, 16.70, 1.90, 0, 0), (-2.6, 10.8, 16.10, 1.67, 0, 0), (8.7, -26.3, 7.52, 1.66, 0, 0), (4.3, -24.9, 10.30, 2.02, 0, 0)),
    'avalanche-forest-l': ((4.0, -0.6, 0.37, 2.97, 0, 0), (3.3, 1.9, 0.34, 2.75, 1, 0), (5.3, -1.3, 0.36, 2.79, 0, 0), (5.2, -3.0, 0.37, 2.91, 0, 0), (-2.1, 0.1, 0.33, 2.62, 0, 0), (-4.0, 4.0, 0.22, 2.83, 0, 0), (-0.3, 4.1, 0.24, 2.71, 1, 0), (-6.8, -3.0, 0.52, 2.95, 0, 1), (-4.5, -3.7, 0.46, 2.82, 0, 0)),
}

# THE SNOW CUP'S ONE FIR is the Holiday Kit's (tree-snow-a/b/c), the scatter's
# tree: the stands and every piece that plants a fir instance the same three
# models, so a track has one make of tree (the stacked-tier firs built here
# before stood beside them as a second make, and the user sent them back).
# A lite stand (FIR_LITE) plants the kit fir's lite build, the decimated
# model the box's scatter draws.
FIR_LITE = False
_KIT_FIRS = {}

def kit_fir(kind, at, tall):
    """The kit fir `kind` (a, b or c) at `at`, `tall` units high, turned its
    own way (a hash of where it stands)."""
    key = (kind, FIR_LITE)
    if key in _KIT_FIRS:
        try:
            _KIT_FIRS[key][0].name          # the scene is cleared between pieces: the mesh may be gone
        except ReferenceError:
            del _KIT_FIRS[key]
    if key not in _KIT_FIRS:
        path = (os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'assets', 'toycar',
                             'tree-snow-%s-lite.glb' % kind) if FIR_LITE
                else os.path.join(KIT_CACHE, 'holiday', 'models', 'tree-snow-%s.glb' % kind))
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        new = [o for o in bpy.context.scene.objects if o not in before]
        src = next(o for o in new if o.type == 'MESH')
        bpy.ops.object.select_all(action='DESELECT')
        src.select_set(True)
        bpy.context.view_layer.objects.active = src
        bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        me = src.data
        for i, m in enumerate(list(me.materials)):
            if 'tex:holiday' in bpy.data.materials:
                me.materials[i] = bpy.data.materials['tex:holiday']
            else:
                m.name = 'tex:holiday'
        h = max(v.co.z for v in me.vertices)
        for o in new:
            bpy.data.objects.remove(o, do_unlink=True)
        _KIT_FIRS[key] = (me, h)
    me, h = _KIT_FIRS[key]
    o = bpy.data.objects.new('fir', me.copy())
    bpy.context.scene.collection.objects.link(o)
    sc = tall / h
    o.scale = (sc, sc, sc)
    o.rotation_mode = 'XYZ'
    x, y, z = at
    # its spine: an unseen bar up the middle from under its foot, through
    # every tier (the kit's tiers are parts of their own, a hand apart: this
    # is what holds them, and the tree, for set-check)
    lo = y - 0.22 * tall
    box((0.05 * tall, 0.82 * tall - (lo - y), 0.05 * tall), (x, (lo + y + 0.82 * tall) / 2, z), 0x7a5a3a)['chamfer'] = 0
    return place(o, at, yaw=frac(math.sin(x * 12.9898 + z * 78.233) * 43758.5453) * 2 * math.pi)

def spruce(at, k=1.0):
    """The taller of the kit's firs."""
    kit_fir('b', at, 2.2 * k)

def dark_pine(at, k=1.0):
    """The third of the kit's firs."""
    kit_fir('c', at, 1.9 * k)

def snapped_trunk(x, g, z, k, yaw):
    """A trunk a slide snapped and laid down, its broken end jagged, bedded
    a little in the snow at `g`."""
    o = cyl(0.13 * k, 2.0 * k, (x, g + 0.05 * k, z), 0x7a5a3a, r2=0.1 * k, segs=6, axis='across', yaw=yaw, stem=True)
    box((0.16 * k, 0.22 * k, 0.1 * k), (x, g + 0.12 * k, z), 0x8a6a46, yaw=yaw, roll=0.5)
    return o

def stump(x, g, z, k, yaw):
    """A trunk snapped off a man's height up, a jagged shard on its top and
    snow on its break."""
    cyl(0.17 * k, 0.7 * k, (x, g - 0.2 * k, z), 0x7a5a3a, r2=0.14 * k, segs=6, stem=True)
    box((0.1 * k, 0.4 * k, 0.12 * k), (x + 0.06 * k, g + 0.62 * k, z), 0x8a6a46, yaw=yaw, roll=0.35)
    snowy(box((0.26 * k, 0.06 * k, 0.26 * k), (x, g + 0.5 * k, z), 0xf3f7fb, yaw=yaw), 0.45)

def forest(trees, lite=False):
    """A stand of pines on the sampled ground, each trunk run on down through
    the hill to the plain (unseen, so unchamfered; it holds the tree up for
    set-check), and a patch of snow under the first one's skirt lying on the
    drawn slope (drape_), so the stand stands on the plain and levels
    nothing. Heaps of snow out on the slope drew as white slivers: a draped
    block on a steep face stretches with it. A row may carry a form (0 pine,
    1 spruce, 2 a snapped trunk lying, 3 a stump, 4 a dark pine) and whether
    the lite build keeps it."""
    global FIR_LITE
    FIR_LITE = lite
    for i, t in enumerate(trees):
        x, z, g, k = t[:4]
        form = t[4] if len(t) > 4 else 0
        if form == 0:
            pine((x, g - 0.35 * k, z), k)
        elif form == 1:
            spruce((x, g - 0.35 * k, z), k)
        elif form == 2:
            snapped_trunk(x, g, z, k, 0.9 + 2.3 * i)
        elif form == 3:
            stump(x, g, z, k, 1.3 * i)
        else:
            dark_pine((x, g - 0.35 * k, z), k)
        top = g + 0.4 * k if form in (2, 3) else g      # a trunk or a stump is held from its break
        box((0.24 * k, top, 0.24 * k), (x, top / 2 - 0.35 * k, z), 0x7a5a3a)['chamfer'] = 0
    FIR_LITE = False
    join_still('pines')
    x, z, _, k = trees[0][:4]
    draped('patch', lambda: box((0.5 * k, 0.1, 0.5 * k), (x, -0.06, z), 0xf3f7fb))

# Each stand and its lite build (every other tree: a stand up a slope is what
# the box's cells barely see; native/renderer/CLAUDE.md, the detail tier).
# Avalanche's mountainside is wooded from the kerb to the crest, and its
# snowy pines keep most of their vertices in their far forms (the snow shell
# rides proud of each tier), so its lite stands keep what the row marks: every
# tree within 8 u of the kerb (1), every other one at a cirque face's foot (2;
# all of them put the run to the S-bend over the box's 4P ceiling, the cirque
# ahead in every cell), and a tenth of the rest.
def lite_trees(name, trees):
    if name in ('flurry-forest-h', 'flurry-forest-i', 'flurry-forest-j', 'flurry-forest-k'):
        return trees[::4]          # the far north-west ridge's hollows: a quarter says "wooded" on the box
    if not name.startswith('avalanche-'):
        return trees[::2]
    near = lambda t: t[5] if len(t) > 5 else 0
    # (round 9: two of three by the kerb, a third at the cirque's foot, a twelfth of the rest;
    # the shared far-form fix made every lite tree dearer)
    return [t for i, t in enumerate(trees) if (near(t) == 1 and i % 3 != 2) or (near(t) == 2 and i % 3 == 0) or i % 12 == 0]

# Avalanche's old giants and a third of its grown pines are dark pines, the
# dark mass in its stands; the saplings and the spruces keep their snow.
def darkened(name, trees):
    if not name.startswith('avalanche-'):
        return trees
    return tuple(t[:4] + (4,) + t[5:] if len(t) > 4 and t[4] == 0 and (t[3] >= 2.6 or (t[3] >= 1.4 and i % 3 == 0))
                 else t for i, t in enumerate(trees))

for _name, _trees in FORESTS.items():
    _trees = darkened(_name, _trees)
    for _n, _t in ((_name, _trees), (_name + '-lite', lite_trees(_name, _trees))):
        PIECES[_n] = (lambda trees, lite: lambda: forest(trees, lite))(_t, _n.endswith('-lite'))
        GROW[_n] = 1.0

def skater(x, y, z, coat, hat, k=1.0):
    """A skater gliding toward +X on one skate, the other leg lifted behind,
    arms straight out for balance, a hat and a scarf in a second colour: nine
    chunky blocks, the pivot at the skate. Joined into one moving part by its
    caller."""
    def b(size, dx, dy, dz, color, roll=0.0):
        box([s * k for s in size], (x + dx * k, y + dy * k, z + dz * k), color, roll=roll)
    TROUSERS, SKIN, BOOT = 0x38383d, 0xf2bf99, 0xfff6eb
    b((0.56, 0.32, 0.28), 0.05, 0.16, 0.15, BOOT)                      # the gliding skate
    b((0.26, 0.8, 0.26), 0.0, 0.7, 0.15, TROUSERS, roll=-0.12)          # the standing leg
    b((0.26, 0.74, 0.26), -0.42, 0.88, -0.15, TROUSERS, roll=0.9)       # the lifted leg, behind
    b((0.6, 0.85, 0.7), 0.05, 1.55, 0.0, coat, roll=-0.25)             # the coat, leaning in
    b((0.3, 0.3, 2.3), 0.05, 1.72, 0.0, coat)                           # arms out
    b((0.5, 0.5, 0.5), 0.2, 2.32, 0.0, SKIN)                            # the head
    b((0.56, 0.3, 0.56), 0.18, 2.64, 0.0, hat)                          # the hat

def shanty(x, z, color, yaw=0.0, pipe=False):
    """An ice-fishing shanty at its real size: a box hut on skids, a snowed
    roof, a dark door to +X turned by `yaw`, maybe a stovepipe."""
    c, s = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + dx * c + dz * s, dy, z - dx * s + dz * c)
    box((0.66, 0.06, 0.5), at(0, 0.03, 0), 0x6e4a32, yaw=yaw)
    box((0.6, 0.48, 0.46), at(0, 0.3, 0), color, yaw=yaw)
    snowy(box((0.7, 0.08, 0.56), at(0, 0.58, 0), 0xfff6eb, yaw=yaw, roll=0.12), 0.5)
    box((0.06, 0.32, 0.2), at(0.31, 0.24, 0), 0x38383d, yaw=yaw)
    if pipe:
        box((0.07, 0.24, 0.07), at(-0.18, 0.72, 0.12), 0x555b66, yaw=yaw)

def clip(pts, keep):
    """Sutherland-Hodgman: the part of polygon `pts` where keep(x, z) >= 0,
    `keep` linear (a half-plane)."""
    out = []
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        ka, kb = keep(*a), keep(*b)
        if ka >= 0:
            out.append(a)
        if (ka >= 0) != (kb >= 0):
            t = ka / (ka - kb)
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out

def slab(outline, y0, y1, color):
    """A flat slab cut to a simple `outline`, from y0 up to y1: a sheet of ice."""
    n = len(outline)
    verts = [(x, y0, z) for x, z in outline] + [(x, y1, z) for x, z in outline]
    faces = [tuple(range(n, 2 * n))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    me = bpy.data.meshes.new('slab')
    me.from_pydata([tuple(P(*v)) for v in verts], [], faces)
    me.update()
    if me.polygons[0].normal.z < 0:
        for p in me.polygons:
            p.flip()
    o = bpy.data.objects.new('slab', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

# Flurry's lake, placed at yaw 180 so the piece's +X is the road's right: the
# road comes down off the bridge across it, running down -Z from (12.4, 21)
# to (11.4, -2) on its stilts, then on its berm (z 0.5 .. -11), and bends
# right round the east ice at z -12 .. -22 to run off along z -23. The ice
# never goes under the deck. The west sheet stops on lines along the road
# (LAKE_ROAD, the road there as a straight line): 4.3 u off its centreline
# beside the stilts, 6.2 u beside the berm. The east sheet fills the inside
# of the bend, outlined as close: clear of the deck, the berms on both ramps,
# the start straight to the north and the cabin to the east (LAKE_E).
# Flurry's SET_GROUND holds the plain under both.
LAKE_ROAD = ((12.4, 21.0), (11.4, -2.0))
LAKE_BERM_Z = 1.5
LAKE_W = dict(cx=0.0, cz=-1.5, half=3.5, r=15.0, off=4.3, berm=6.2)
LAKE_E = ((16.3, 13.0), (25.5, 14.0), (26.8, 9.0), (27.0, 3.0), (28.5, -1.5), (28.5, -13.5),
          (26.5, -16.0), (19.6, -16.7), (17.9, -11.0), (17.9, 0.0), (16.0, 2.0))

def road_clear(off):
    """keep(x, z) >= 0 west of LAKE_ROAD by `off`."""
    (x0, z0), (x1, z1) = LAKE_ROAD
    return lambda x, z: x0 + (z - z0) * (x1 - x0) / (z1 - z0) - off - x

def shrink(pts, d):
    """An outline pulled in toward its centroid by `d` all round."""
    cx = sum(x for x, _ in pts) / len(pts)
    cz = sum(z for _, z in pts) / len(pts)
    out = []
    for x, z in pts:
        l = math.hypot(x - cx, z - cz)
        out.append((x - (x - cx) / l * d, z - (z - cz) / l * d))
    return out

def rounded(pts, times=2):
    """A closed outline with its corners cut (Chaikin), `times` over: a shore
    drawn as a polygon, worn round."""
    for _ in range(times):
        out = []
        for i in range(len(pts)):
            (ax, az), (bx, bz) = pts[i], pts[(i + 1) % len(pts)]
            out.append((ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25))
            out.append((ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75))
        pts = out
    return pts

def lake_west(inset, seed):
    """The west sheet's shore, `inset` in from it: the old running-track oval
    (LAKE_W) worn into bays and points (never past it: the plain under it
    ends there), and along the road no line ruled beside it but a shore that
    wanders in and out, keeping the old clearances (off the stilts, further
    off the berm, eased from one to the other)."""
    W = LAKE_W
    (x0, z0), (x1, z1) = LAKE_ROAD
    R, half, N = W['r'], W['half'], 60
    pts = []
    for i in range(N):
        a = i / N * 2 * math.pi
        dx, dz = math.cos(a), math.sin(a)
        t = R / abs(dx) if abs(dx) > 1e-6 else 1e9
        if abs(t * dz) > half:
            t = abs(dz) * half + math.sqrt(max(0.0, (dz * half) ** 2 - half * half + R * R))
        t = t * (0.925 + 0.075 * wobble(i, seed, 11.0)) - inset
        x, z = W['cx'] + dx * t, W['cz'] + dz * t
        off = W['off'] + (W['berm'] - W['off']) * smooth01((LAKE_BERM_Z + 1.5 - z) / 3.0)
        lim = x0 + (z - z0) * (x1 - x0) / (z1 - z0) - off - inset - 0.9 * (0.5 + 0.5 * wobble(z, seed + 2, 6.0))
        pts.append((min(x, lim), z))
    return pts

def lake_east(inset, seed):
    """The east sheet's shore: the outline that clears the roads round it
    (LAKE_E), a little inside it, its corners worn round and its line
    wandering inward here and there."""
    pts = rounded(shrink(LAKE_E, 0.25 + inset), 2)
    cx = sum(x for x, _ in pts) / len(pts)
    cz = sum(z for _, z in pts) / len(pts)
    out = []
    for i, (x, z) in enumerate(pts):
        l = math.hypot(x - cx, z - cz)
        d = 0.35 * (0.5 + 0.5 * wobble(i, seed, 7.0))
        out.append((x - (x - cx) / l * d, z - (z - cz) / l * d))
    return out

def shore_snow(pts, seed):
    """The snow at the ice's edge: a soft lip lying over it all the way round
    (its crest a hand's breadth up, wider and narrower as it goes), so the
    sheet ends under a bank of snow instead of at a slab's cut edge."""
    cx = sum(x for x, _ in pts) / len(pts)
    cz = sum(z for _, z in pts) / len(pts)
    rows = []
    n = len(pts)
    for i in range(n + 1):
        x, z = pts[i % n]
        (ax, az), (bx, bz) = pts[(i - 1) % n], pts[(i + 1) % n]
        tx, tz = bx - ax, bz - az
        m = math.hypot(tx, tz) or 1.0
        nx, nz = tz / m, -tx / m
        if nx * (x - cx) + nz * (z - cz) < 0:
            nx, nz = -nx, -nz
        w = 0.5 + 0.3 * wobble(i % n, seed, 5.0)
        rows.append([(x - nx * (0.35 + w), 0.085, z - nz * (0.35 + w)), (x - nx * 0.1, 0.2 + 0.08 * w, z - nz * 0.1),
                     (x + nx * 0.75, -0.04, z + nz * 0.75)])
    for o in sheet(rows, lambda i, j, nn: SNOW, 'shore'):
        snowy(o, 0.4)

def ice_drift(x, z, L, w, yaw, seed):
    """Snow the wind has blown across the ice: a thin ragged tongue `L` long
    and `w` wide, turned by `yaw`."""
    c, s2 = math.cos(yaw), math.sin(yaw)
    pts = []
    for i in range(12):
        a = i / 12 * 2 * math.pi
        r = 1.0 + 0.3 * jitter(i, 3, seed)
        lx, lz = math.cos(a) * L / 2 * r, math.sin(a) * w / 2 * r
        pts.append((x + lx * c + lz * s2, z - lx * s2 + lz * c))
    snowy(slab(pts, 0.0, 0.09, 0xf3f7fb), 0.4)

def ice_fisher(x, z, yaw, coat, hat, n, seat=0xcf534f, rod=True, screen=None, sledge=None, flag=False):
    """Someone fishing through the ice at (x, z), sat facing +X turned by
    `yaw` at their hole: bundled up and small (a seated figure a little over
    a third of a unit, hood up, no face to read), on an upturned bucket or a
    box, the dark hole in front in its ring of shaved ice, the short rod
    held over it and jigged now and then (`rod`, a part of its own). Round
    them what an ice fisher brings: a canvas windbreak at their back
    (`screen`, its colour), a sledge with its box (`sledge`, its colour), a
    tip-up's little flag over a second hole (`flag`), the catch laid on the
    ice, the auger stood in the snow. Returns nothing: all of it stands on
    the ice at y 0.07."""
    Y = 0.07
    c, s2 = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + dx * c + dz * s2, Y + dy, z - dx * s2 + dz * c)
    DARK = 0x38383d
    cyl(0.3, 0.02, at(0.62, 0.0, 0.0), 0xfff6eb, segs=10)                       # the shaved ice round the hole
    cyl(0.17, 0.03, at(0.62, 0.0, 0.0), 0x2f3a4a, segs=10)                      # the hole
    box((0.2, 0.2, 0.2), at(0.0, 0.1, 0.0), seat, yaw=yaw)                       # what they sit on
    box((0.3, 0.1, 0.2), at(0.12, 0.25, 0.0), DARK, yaw=yaw)                     # thighs
    box((0.1, 0.24, 0.2), at(0.27, 0.12, 0.0), DARK, yaw=yaw)                    # shins and boots
    box((0.22, 0.3, 0.26), at(-0.02, 0.42, 0.0), coat, yaw=yaw)                  # the coat, bundled
    box((0.16, 0.14, 0.3), at(0.12, 0.4, 0.0), coat, yaw=yaw)                    # arms forward
    box((0.17, 0.16, 0.18), at(0.0, 0.64, 0.0), hat, yaw=yaw)                    # the hood
    box((0.06, 0.09, 0.12), at(0.085, 0.63, 0.0), 0xf2bf99, yaw=yaw)             # what shows of a face
    if rod:
        with animated('anim_sway:a=z:d=9:p=%.1f:r=%.2f#rod%d' % (1.6 + 0.3 * (n % 4), 0.45 + 0.08 * (n % 3), n),
                      at(0.2, 0.42, 0.0), yaw):
            box((0.5, 0.04, 0.04), at(0.44, 0.45, 0.0), 0x2a2735, yaw=yaw, roll=-0.12)
            box((0.04, 0.4, 0.04), at(0.64, 0.28, 0.0), 0xfff6eb, yaw=yaw)        # the line down the hole
    if screen is not None:
        for sd in (-1, 1):
            box((0.06, 0.7, 0.06), at(-0.45, 0.35, sd * 0.55), 0x7a5a3a, yaw=yaw)
        box((0.06, 0.5, 1.1), at(-0.45, 0.42, 0.0), screen, yaw=yaw)
        snowy(box((0.3, 0.12, 1.2), at(-0.62, 0.06, 0.0), 0xf3f7fb, yaw=yaw), 0.4)   # snow banked against it
    if sledge is not None:
        sx, sz = -0.15, 0.75
        for sd in (-1, 1):
            box((0.7, 0.05, 0.05), at(sx, 0.03, sz + sd * 0.13), 0x555b66, yaw=yaw)
        box((0.6, 0.06, 0.34), at(sx - 0.03, 0.1, sz), sledge, yaw=yaw)
        box((0.3, 0.2, 0.26), at(sx - 0.1, 0.23, sz), 0x9a7b55, yaw=yaw)         # its box
        box((0.12, 0.12, 0.12), at(sx + 0.17, 0.19, sz), 0x3f7bd9, yaw=yaw)       # a flask
    if flag:
        cyl(0.13, 0.03, at(0.5, 0.0, -0.8), 0x2f3a4a, segs=8)                    # the tip-up's hole
        box((0.34, 0.04, 0.04), at(0.5, 0.05, -0.8), 0x7a5a3a, yaw=yaw)
        box((0.04, 0.4, 0.04), at(0.5, 0.2, -0.8), 0x7a5a3a, yaw=yaw)
        box((0.16, 0.12, 0.04), at(0.58, 0.36, -0.8), 0xff7e44, yaw=yaw)
    for k in range(1 + n % 3):                                                   # the catch
        box((0.2, 0.05, 0.07), at(0.5 + 0.1 * k, 0.025, 0.42 + 0.11 * k), 0xa0a8c9, yaw=yaw + 0.4 * k)
    if n % 2 == 0:                                                               # the auger, stood up
        box((0.06, 0.6, 0.06), at(-0.1, 0.3, -0.5), 0x555b66, yaw=yaw)
        box((0.3, 0.05, 0.05), at(-0.1, 0.6, -0.5), 0xff7e44, yaw=yaw)
        box((0.14, 0.14, 0.14), at(-0.1, 0.07, -0.5), 0x868ba1, yaw=yaw)

@piece(1.0)
def frozen_lake():
    # Flurry: a frozen lake at the bottom of the land, the plain it lies on is
    # the track's terrain (SET_GROUND), and the road crosses it between its
    # two sheets on its stilts. Built in world units, everything on the ice at
    # its real size beside a car: six skaters (half a unit tall) glide round a
    # rink on the west ice at a skater's pace (anim_path; carried by their
    # skates, they hold their pose); on the east ice, ahead on the right of a
    # racer coming down off the bridge, the village's ice fishers sat at
    # their holes (ice_fisher), each with what they brought; a snowman on the
    # ice by the rink. Both sheets have a lake's shore: bays and points, the
    # snow lying over the ice's edge, drifts blown across it (lake_west,
    # lake_east, shore_snow), nothing ruled.
    west = lake_west(0.0, 3.0)
    slab(west, 0.0, 0.06, 0xa9d7ee)
    slab(lake_west(3.0, 8.0), 0.0, 0.07, 0x8ecae6)                    # the clear ice in the middle
    shore_snow(west, 4.0)
    east = lake_east(0.0, 5.0)
    slab(east, 0.0, 0.06, 0xa9d7ee)
    slab(lake_east(2.3, 9.0), 0.0, 0.07, 0x8ecae6)
    shore_snow(east, 6.0)
    for i, (x, z, L, w, yw) in enumerate(((-10.5, -8.0, 5.0, 1.6, 0.5), (-11.0, 9.5, 4.2, 1.4, -0.6),
                                          (3.5, -12.5, 4.6, 1.3, 0.2), (-4.0, 13.5, 3.6, 1.2, 0.15),
                                          (4.0, 12.0, 2.6, 1.0, -0.3), (-12.5, 1.0, 2.8, 1.1, 1.3),
                                          (24.5, 9.0, 3.4, 1.2, 0.7), (25.0, -3.0, 3.0, 1.1, -0.5),
                                          (20.5, 6.5, 2.4, 0.9, 0.2))):
        ice_drift(x, z, L, w, yw, 2.0 + i)
    # the rink: an oval on the west ice, the skaters spread round it
    N = 14
    rc, rx, rz = (-2.0, 4.0), 4.5, 5.5
    for j in range(N):
        a = j / N * 2 * math.pi
        marker('path_rink_%d' % j, (rc[0] + math.cos(a) * rx, 0.07, rc[1] + math.sin(a) * rz))
    for n, (coat, hat) in enumerate(((0xcf534f, 0x3f7bd9), (0x3f7bd9, 0xffc044), (0x61cb8b, 0xcf534f),
                                     (0xa878e8, 0xfff6eb), (0xff7e44, 0x3f7bd9), (0xfff6eb, 0xcf534f))):
        a = n / 6 * 2 * math.pi
        at = (rc[0] + math.cos(a) * rx, 0.07, rc[1] + math.sin(a) * rz)
        with animated('anim_path:c=rink:p=26:o=%.3f:f=1#%d' % (n / 6, n), at):
            skater(at[0], at[1], at[2], coat, hat, k=0.19)
    # the fishers on the east ice, turned every which way round their holes,
    # the nearest by the shore the racer runs along (the bend's inside)
    FISH = ((20.4, -8.6, 2.6, 0xcf534f, 0xcf534f, 0xffc044, 0x3f7bd9, True),
            (21.6, -11.6, 1.2, 0x3f7bd9, 0xffc044, None, 0xcf534f, False),
            (22.6, -6.0, -2.4, 0xffc044, 0x38383d, 0xcf534f, None, True),
            (20.2, -3.4, 2.0, 0x61cb8b, 0xfff6eb, None, 0xff7e44, False),
            (24.2, -10.2, -1.2, 0xa878e8, 0x3f7bd9, 0x61cb8b, None, False),
            (21.2, 1.6, -2.9, 0xff7e44, 0x38383d, 0x3f7bd9, 0xffc044, True),
            (23.6, -1.4, 0.6, 0xcf534f, 0xfff6eb, None, None, False),
            (22.6, 6.2, 2.7, 0x3f7bd9, 0xcf534f, 0xffc044, 0x61cb8b, False))
    for n, (fx, fz, fyaw, coat, hat, screen, sledge, flag) in enumerate(FISH):
        ice_fisher(fx, fz, fyaw, coat, hat, n, seat=(0xcf534f, 0x3f7bd9, 0x9a7b55)[n % 3], screen=screen,
                   sledge=sledge, flag=flag)
    # on the ice by the rink, a snowman in a hat
    snowman((-7.6, 0.07, 5.0), 0.15, hat=True)

@piece(1.0)
def snow_fort():
    # Glacier: the SNOW CASTLE the expedition's children (and, by the look of
    # it, everyone else on the glacier) built: one castle, every part of it
    # different, big as a thing of snow can be. A curtain wall of ice blocks
    # in three courses round a yard some eleven units by nine, battlements of
    # snow along it; the gatehouse to the road (+X), two square towers and an
    # arch of blocks between them over the dark gate, bunting across; the
    # great round keep in the yard, nine courses and a crown under a cone of
    # snow, the red flag over it all; at the corners a round tower under its
    # own snow cone, a square one with a banner, a slim turret leaning a
    # little, and one only half built, its ladder and blocks beside it; an
    # ice slide off the south wall; in the yard the snow king on his throne.
    # The blocks are cut from the glacier's ice, pale blue in two tones so
    # the courses show, under the snow lying on every top: a white castle on
    # white snow did not read from the road. Beside it (+Z) the builders'
    # igloo camp, one scene with it. Placed with its gate to the road.
    SNOW, ICE, ICE2, DARK = 0xf3f7fb, 0x9fd6ee, 0xd0e8ff, 0x2f3a4a
    CH = 0.55                                                      # a course
    H = 2.0                                                        # where the igloo camp stands off (+Z)
    def tone(c):
        return ICE if c % 2 == 0 else ICE2
    def course(size, at, c, yaw=0.0, top=False):
        o = snowy(box(size, at, SNOW if top else tone(c), yaw=yaw), 0.4 if top else 0.35)
        if top:
            o['round'] = 0.1
        return o
    def wall(pa, pb, courses=3, thick=0.6, gap=None):
        """A run of curtain wall from pa to pb (x, z), merlons of snow along
        its top; `gap` (from, to along it) leaves the gate open."""
        dx, dz = pb[0] - pa[0], pb[1] - pa[1]
        L = math.hypot(dx, dz)
        yaw = math.atan2(dx, dz)
        runs = [(0.0, L)] if gap is None else [(0.0, gap[0]), (gap[1], L)]
        for (t0, t1) in runs:
            mx, mz = pa[0] + dx * (t0 + t1) / 2 / L, pa[1] + dz * (t0 + t1) / 2 / L
            for cc in range(courses):
                course((thick - 0.04 * cc, CH, t1 - t0), (mx, CH / 2 + cc * CH, mz), cc, yaw=yaw)
            n = max(1, int((t1 - t0) / 1.15))
            for k in range(n):
                t = t0 + (t1 - t0) * (k + 0.5) / n
                course((thick + 0.06, 0.34, 0.5), (pa[0] + dx * t / L, courses * CH + 0.17, pa[1] + dz * t / L), 0,
                       yaw=yaw, top=True)
    def round_tower(x, z, R, courses, cone=True, lean=0.0):
        for cc in range(courses):
            snowy(cyl(R * (1 - 0.015 * cc), CH + 0.02, (x + lean * cc, cc * CH, z), tone(cc), segs=10), 0.35)
        top = courses * CH
        tx = x + lean * courses
        snowy(cyl(R + 0.22, 0.2, (tx, top - 0.02, z), SNOW, segs=10), 0.4)
        for k in range(6):
            a_ = k / 6 * 2 * math.pi
            course((0.3, 0.32, 0.42), (tx + math.cos(a_) * (R + 0.02), top + 0.32, z + math.sin(a_) * (R + 0.02)), 0,
                   yaw=-a_, top=True)
        if cone:
            snowy(cyl(R * 0.92, R * 1.7, (tx, top + 0.15, z), SNOW, r2=0.05, segs=10), 0.4)
        box((0.2, CH * 1.2, 0.3), (x + R * 0.9 + lean * courses * 0.6, top - CH * 2.2, z), DARK)   # a window to the road
        return top
    def square_tower(x, z, w, courses):
        for cc in range(courses):
            course((w - 0.03 * cc, CH, w - 0.03 * cc), (x, CH / 2 + cc * CH, z), cc)
        top = courses * CH
        course((w + 0.24, 0.16, w + 0.24), (x, top + 0.08, z), 0, top=True)
        for sx in (-1, 1):
            for sz in (-1, 1):
                course((0.42, 0.36, 0.42), (x + sx * (w / 2 - 0.1), top + 0.34, z + sz * (w / 2 - 0.1)), 0, top=True)
        box((0.08, CH * 1.2, 0.3), (x + w / 2, top - CH * 1.8, z), DARK)
        return top
    # the curtain wall: an uneven ring, the gate in its front run
    NE, SE, SW, W_, NW = (4.2, 5.6), (4.2, -5.2), (-3.6, -6.0), (-5.4, 0.4), (-3.2, 5.8)
    wall(SE, NE, gap=(3.6, 7.2))
    wall(NE, NW)
    wall(NW, W_)
    wall(W_, SW)
    wall(SW, SE)
    # the gatehouse: two square towers, the arch between them, the gate dark
    gz = (SE[1] + NE[1]) / 2
    for sz in (-1, 1):
        gt = square_tower(4.4, gz + sz * 1.9, 1.5, 5)
    R = 1.15
    for i in range(7):
        t = (i + 0.5) / 7 * math.pi
        snowy(box((0.7, 0.4, R * math.pi / 7 + 0.05), (4.4, R * math.sin(t) + 0.55, gz + R * math.cos(t)), tone(i),
                  pitch=t - math.pi / 2), 0.35)
    for sz in (-1, 1):
        course((0.7, 0.55, 0.42), (4.4, 0.27, gz + sz * 1.14), 0)
    box((0.12, 1.5, 2.1), (4.15, 0.75, gz), DARK)                    # the gate's dark
    course((0.66, 0.5, 2.5), (4.4, 2.05, gz), 1)                     # the wall over the arch
    for k in range(3):
        course((0.72, 0.34, 0.5), (4.4, 2.47, gz - 0.85 + 0.85 * k), 0, top=True)
    # the corner towers, no two alike
    rt = round_tower(NE[0], NE[1], 1.15, 6)
    st = square_tower(SE[0], SE[1], 1.7, 6)
    round_tower(NW[0], NW[1], 0.75, 8, lean=0.035)                   # the slim turret, leaning
    for cc in range(2):                                              # the one half built
        for k in range(5 if cc == 0 else 3):
            a_ = (k + 0.5 * cc) / 5 * 2 * math.pi
            course((0.42, CH, 0.95), (SW[0] + math.cos(a_) * 0.95, CH / 2 + cc * CH, SW[1] + math.sin(a_) * 0.95), cc + k,
                   yaw=-a_)
    for k, (dx, dz) in enumerate(((-1.7, -0.9), (-1.9, 0.1), (-1.5, 0.9))):   # its blocks, cut and waiting
        course((0.5, 0.45, 0.9), (SW[0] + dx, 0.22, SW[1] + dz), k, yaw=0.4 * k)
    for sd in (-1, 1):                                               # and its ladder
        box((0.07, 1.9, 0.07), (SW[0] + 1.25, 0.9, SW[1] + 0.5 + sd * 0.22), 0x8a6a46, roll=0.22)
    for k in range(5):
        box((0.06, 0.06, 0.5), (SW[0] + 1.42 - 0.085 * k, 0.3 + 0.36 * k, SW[1] + 0.5), 0x9a7b55)
    # the keep in the yard: nine courses, a crown, a cone of snow, the flag
    KX, KZ, KR = -1.6, 0.3, 1.75
    kt = round_tower(KX, KZ, KR, 9)
    for k in range(4):                                               # its buttresses
        a_ = k / 4 * 2 * math.pi + 0.6
        course((0.7, CH * 3, 0.8), (KX + math.cos(a_) * (KR + 0.1), CH * 1.5, KZ + math.sin(a_) * (KR + 0.1)), 1, yaw=-a_)
    tx, tz = KX, KZ
    flag_across((tx, kt + 0.15 + KR * 1.7 - 0.5, tz), 1.9, 0xff5040, 'anim_sway:a=x:d=22:p=1.9#flag', w=1.1, fh=0.65)
    # banners: one hung down the square tower, bunting across the gate
    box((0.06, 1.3, 0.7), (SE[0] + 0.9, st - 0.9, SE[1]), 0xcf534f)
    box((0.07, 0.3, 0.3), (SE[0] + 0.92, st - 0.9, SE[1]), 0xffc044)
    for k in range(7):
        box((0.05, 0.3, 0.2), (5.2, gt - 0.16, gz - 1.5 + 0.5 * k),
            (0xff5040, 0xffc044, 0x3f7bd9, 0x61cb8b)[k % 4])
    box((0.04, 0.04, 3.4), (5.2, gt - 0.02, gz), 0xfff6eb)
    for sz in (-1, 1):
        box((0.06, 0.5, 0.06), (5.2, gt - 0.2, gz + sz * 1.68), 0x9a7b55)
    # the ice slide off the south wall, a sled at its foot
    ramp((0.4, 3 * CH + 0.05, SW[1] + 0.4), (0.4, 0.12, SW[1] - 4.2), 1.0, 0.3, ICE2)
    for sd in (-1, 1):
        ramp((0.4 + sd * 0.56, 3 * CH + 0.25, SW[1] + 0.4), (0.4 + sd * 0.56, 0.32, SW[1] - 4.2), 0.16, 0.3, SNOW)
    box((1.3, 3 * CH, 0.5), (0.4, 1.5 * CH, SW[1] + 0.55), ICE)      # the steps up to it, inside
    sled(0.4, 0, SW[1] - 4.9, math.pi / 2, 0xcf534f, L=0.6)
    # the snow king on his throne in the yard, his court of two
    course((0.9, 0.5, 1.0), (1.9, 0.25, 2.6), 1)
    course((0.3, 1.3, 1.0), (1.5, 0.65, 2.6), 0)
    snowfolk(2.0, 2.6, 1.3, yaw=0.0, hat='bucket', hat_c=0xffc044, scarf=0xa878e8, arms='out', balls=3)
    snowfolk(2.6, 1.2, 0.8, yaw=0.3, hat='cone', hat_c=0x3f7bd9, scarf=0xff5040, arms='up', balls=2)
    snowfolk(2.7, 3.9, 0.8, yaw=-0.3, hat='bobble', hat_c=0xcf534f, scarf=0x61cb8b, arms='down', balls=2)
    with plain_parts():                                            # small things: no chamfer to see
        # pennants on the corners, flying in the wind the tower's flag flies
        # in: each dips and lifts about its pole's head, out of step
        for k, (x, z, y0, sz, c) in enumerate(((4.4, gz + 1.9, gt + 0.1, 1, 0x3f7bd9), (4.4, gz - 1.9, gt + 0.1, -1, 0x61cb8b),
                                               (NE[0], NE[1], rt + 0.15 + 1.15 * 1.7 - 0.45, 1, 0xa878e8))):
            box((0.06, 0.9, 0.06), (x, y0 + 0.45, z), 0x9a7b55)
            tri = [(z + 0.02 * sz, y0 + 0.86), (z + 0.02 * sz, y0 + 0.5), (z - 0.6 * sz, y0 + 0.68)]
            with animated('anim_sway:a=x:d=%d:p=%.1f#pennant%d' % (22 * sz, 1.6 + 0.2 * k, k), (x, y0 + 0.86, z)):
                prism(tri if sz > 0 else tri[::-1], x, 0.04, c)
        for (x, z) in ((5.6, gz + 3.2), (5.9, gz - 3.0), (0.2, 3.9)):   # snowballs: four and one on top
            for dx, dz in ((-0.1, -0.1), (0.1, -0.1), (-0.1, 0.1), (0.1, 0.1)):
                snowy(box((0.17, 0.17, 0.17), (x + dx, 0.085, z + dz), SNOW), 0.4)
            snowy(box((0.17, 0.17, 0.17), (x, 0.24, z), SNOW, yaw=0.6), 0.4)
        snow_person(5.6, 0, gz + 0.5, 0xcf534f, 0x3f7bd9, yaw=0.3)       # the builders: at the gate,
        snow_person(3.0, 0, gz - 0.8, 0x3f7bd9, 0xffc044, yaw=2.6)       # in the yard,
        snow_person(SW[0] + 1.9, 0, SW[1] + 1.3, 0x61cb8b, 0xcf534f, yaw=3.6)   # by the tower still going up,
        snow_person(0.4, 3 * CH + 0.02, SW[1] + 0.75, 0xffc044, 0xcf534f, yaw=-1.57)   # and at the head of the slide
        sled(5.9, 0, gz - 1.2, 0.3, 0xcf534f, L=0.6)                    # left by the gate
        sled(6.2, 0, gz + 1.6, -0.4, 0x3f7bd9, L=0.6)
        igloo_dome(1.3, H + 6.6, 0.75, 0.0)                            # the igloo camp
        igloo_dome(-0.3, H + 8.0, 0.5, -0.5, blocks=False)
        sled(2.9, 0, H + 7.9, 0.2, 0x9a7b55, L=0.7)
        for k in range(3):                                             # the team, lying down
            x, z = 3.05 + (k // 2) * 0.32, H + 7.25 + (k % 2) * 0.28 - 0.2 * (k // 2)
            box((0.24, 0.1, 0.11), (x, 0.06, z), (0x868ba1, 0x38383d, 0xfff6eb)[k], yaw=0.2)
            box((0.09, 0.09, 0.09), (x + 0.14, 0.12, z), (0x868ba1, 0x38383d, 0xfff6eb)[k], yaw=0.2)
    join_still('fort')

@piece(1.0)
def avalanche_slide():
    # Avalanche: a broad mountain behind the verge (summit at -X) whose face
    # let go: the broken crown near the top, the bare rock of the chute below
    # it, and the debris fan of tumbled snow blocks and rocks spread out at
    # its foot toward the road, a pine snapped and its trunk thrown down, a
    # buried sled. Forest stands either side of the chute. The mountain and
    # the fan are the track's terrain (SET_GROUND); this is what lies on them,
    # at its real size: blocks of snow the size of a car or less, pines as
    # tall as the ambient ones.
    H = set_ground('avalanche-slide')
    G = 1.45                                   # the old build's grow: where things lie on the slope
    # What lies on the face and the fan is draped: built from y = 0 as if on
    # the plain, each vertex laid on the slope as the renderer draws it (its
    # 9 u grid's chords stray a unit off the curve), so no block floats and
    # none is swallowed.
    def debris():
        for z in (-2.6, 0.0, 2.6):                 # the crown: the broken edge of the slab
            x = (-28.0 + 0.4 * abs(z)) * G
            box((1.3, 1.4, 4.0), (x, 0.3, z * G), 0x868ba1, yaw=0.15 * z)
        # the chute: the scar the slab left, scoured to grey rock, lying on the
        # face and widening as it runs down into the fan, whose blocks cover
        # its end; fine enough to follow the drawn slope, and lifted a little
        # over it so the grid's folds between its corners stay under
        xs = [(-27.0 + 1.65 * i) * G for i in range(15)]
        verts = []
        for i, x in enumerate(xs):
            w = (1.8 + 0.225 * i) * G
            for f in (-1.0, -0.5, 0.0, 0.5, 1.0):
                verts.append((x, 0.35 - 0.1 * abs(f), f * w + 0.3 * G * math.sin(i / 2)))
        faces = [(5 * i + j, 5 * i + j + 1, 5 * (i + 1) + j + 1, 5 * (i + 1) + j)
                 for i in range(len(xs) - 1) for j in range(4)]
        poly(verts, faces, 0x9aa1b4)
        for i, x in enumerate((-20.0, -12.0, -4.0)):
            x *= G
            z = 0.4 * G * (i % 2 * 2 - 1)
            rock((x, -0.3, z), 0.9, yaw=i * 1.9)
        # earth braking mounds across the runout, two staggered rows, the
        # debris piled up behind them and thinning out between them; nothing
        # past the second row, whose backs stop short of the crest's berm
        MOUNDS = ((3.0, -7.5, 0.15, 2.4), (3.0, 0.0, 0.0, 2.4), (3.0, 7.5, -0.15, 2.4),
                  (8.0, -3.8, 0.1, 1.7), (8.0, 3.8, -0.1, 1.7))
        for mx, mz, myaw, down in MOUNDS:
            braking_mound(mx, mz, myaw, down=down)
        def clear_of_mounds(x, z):
            return x < 10.0 and all(abs(x - mx) > 1.7 or abs(z - mz) > 2.0 for mx, mz, _, _ in MOUNDS)
        # the debris fan: tumbled snow blocks over it, the runout thinning on
        # toward the road (+X). The fan stops a grid cell short of the road,
        # where the deck's cap would hold the land under it.
        for i, (x, z, k) in enumerate([(-6.0, 0.5, 1.5), (-3.0, -2.5, 1.4), (-1.0, 3.0, 1.3), (2.0, -1.0, 1.7),
                                       (3.5, 2.5, 1.4), (4.0, -3.5, 1.3), (5.5, 0.5, 1.2), (6.5, -2.0, 1.0),
                                       (7.0, 3.0, 0.9), (2.5, 4.5, 1.1), (1.5, -4.5, 1.2), (8.0, 0.0, 0.8),
                                       (4.8, 5.2, 0.8), (6.0, -6.0, 0.9), (7.5, 5.8, 0.8), (-4.5, 3.8, 1.0),
                                       (0.0, -6.0, 0.9), (-2.0, 6.5, 0.8), (3.0, 7.0, 0.7), (8.5, -4.0, 0.7)]):
            x, z, k = x * G, z * G, k * 0.5
            if not clear_of_mounds(x, z):
                continue
            snowy(box((1.3 * k, 0.9 * k, 1.1 * k), (x, 0.15 * k, z), 0xf3f7fb,
                      yaw=i * 1.1, roll=0.3 * math.sin(i * 2.3), pitch=0.25 * math.cos(i * 1.7)), 0.5)
        for i, (x, z, k) in enumerate([(3.0, 0.8, 1.0), (5.0, -1.2, 0.8), (1.0, 2.2, 0.9), (6.2, 2.0, 0.7),
                                       (-4.5, -1.0, 0.9)]):
            if clear_of_mounds(x * G, z * G):
                rock((x * G, -0.2, z * G), k, yaw=i * 1.4)
        # the snapped pine: its stump on the slope, the trunk thrown down the fan
        cyl(0.18, 0.8, (-1.0 * G, -0.3, -3.2 * G), 0x7a5a3a, r2=0.15, segs=6)
        cyl(0.16, 3.2, (5.6 * G, 0.05, -5.0 * G), 0x7a5a3a, r2=0.09, segs=6, axis='across', yaw=0.5)
        sled(5.6 * G, -0.05, 1.0 * G, 0.8, 0xcf534f, L=0.5)
    draped('debris', debris)
    x, z = 6.5 * G, -6.4 * G
    pine((x, H(x, z) - 0.3, z), 1.7)
    # forest either side of the chute
    for x, z, k in ((-12.0, -12.0, 1.9), (-6.0, -16.0, 1.8), (-22.0, -14.0, 1.8), (-12.0, 12.0, 1.9),
                    (-5.0, 15.0, 1.8), (-22.0, 14.0, 1.7), (-34.0, -28.0, 1.9), (-32.0, 30.0, 1.9)):
        x, z = x * G, z * G
        pine((x, H(x, z) - 0.6, z), k)

def helicopter(x, y, z, w=14.0):
    """The mountain rescue's helicopter facing +X at its real size (some
    twelve metres, nearly three cars long): a red cabin with a white band and
    dark glass, the tail boom and fin, skids; its two rotors are parts of
    their own that turn at `w` (anim_spin)."""
    RED, GLASS = 0xcf534f, 0x2f3a4a
    box((1.3, 0.8, 0.85), (x, y + 0.55, z), RED)
    box((1.32, 0.16, 0.87), (x, y + 0.4, z), 0xfff6eb)
    box((0.45, 0.55, 0.75), (x + 0.75, y + 0.62, z), GLASS, roll=-0.2)
    box((1.5, 0.2, 0.2), (x - 1.35, y + 0.78, z), RED)
    box((0.35, 0.55, 0.07), (x - 2.0, y + 1.0, z), RED, roll=0.35)
    for sd in (-1, 1):
        box((1.5, 0.07, 0.07), (x + 0.05, y + 0.04, z + sd * 0.42), 0x555b66)
        for dx in (-0.35, 0.4):
            box((0.06, 0.18, 0.06), (x + dx, y + 0.12, z + sd * 0.42), 0x555b66)
    box((0.14, 0.14, 0.14), (x, y + 1.02, z), 0x555b66)
    with animated('anim_spin:a=y:w=%.1f#rotor' % w, (x, y + 1.12, z)):
        box((3.0, 0.05, 0.16), (x, y + 1.12, z), 0x38383d)
        box((0.16, 0.05, 3.0), (x, y + 1.12, z), 0x38383d)
    with animated('anim_spin:a=z:w=%.1f#tail' % (w * 1.6), (x - 2.05, y + 1.0, z + 0.09)):
        box((0.07, 0.62, 0.05), (x - 2.05, y + 1.0, z + 0.09), 0x38383d)

def igloo_dome(cx, cz, R, yaw, blocks=True):
    """An igloo of snow blocks at (cx, cz), `R` its radius (a real one is
    under a unit and a half across): rings of cut blocks stepping in as they
    rise and closing over the top, or (`blocks` off) the packed dome alone;
    a tunnel of blocks out toward +X turned by `yaw`, its doorway dark."""
    snowy(sphere(R * 0.92, (cx, 0, cz), 0xf3f7fb, subdiv=1), 0.4)     # the packed snow behind the joints
    if blocks:
        rows = 2
        span = math.pi / 2 * 0.7 / rows
        for row in range(rows):
            phi = (row + 0.5) * span
            rr = R * math.cos(phi)
            n = max(5, round(2 * math.pi * rr / 0.5))
            for k in range(n):
                a = (k + 0.5 * (row % 2)) / n * 2 * math.pi
                snowy(box((0.14, R * span * 0.94, 2 * math.pi * rr / n * 0.94),
                          (cx + math.cos(a) * rr, R * math.sin(phi), cz + math.sin(a) * rr), 0xf3f7fb,
                          yaw=-a, roll=-phi * 0.85), 0.4)
    c, s = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (cx + dx * c + dz * s, dy, cz - dx * s + dz * c)
    T = R * 0.45                                                      # the tunnel's half-width
    snowy(box((0.7 * R, 0.62 * R, 2.6 * T), at(R * 1.05, 0.31 * R, 0), 0xf3f7fb, yaw=yaw), 0.4)
    box((0.06, 0.45 * R, 1.1 * T), at(R * 1.42, 0.22 * R, 0), 0x2f3a4a, yaw=yaw)

@piece(1.0)
def windsock():
    # Avalanche's patrol post, at its real size beside a car: the avalanche
    # patrol's red hut, a windsock streaming on its mast (one and a half
    # units) and swinging round it as the wind veers off the mountain, a
    # slatted weather screen on legs, a snow stake banded to read the depth,
    # a rescue sled, two of the patrol with their probes by the door, and on
    # over its pad beside the post the rescue helicopter in the hover (the
    # windsock is the pad's); the post's radio mast over it all, banded red
    # and white, what reads of the post over the kerb and the verge.
    cabin_hut(1.5, 0.85, 1.2, (-0.4, 0, -0.6), 0xcf534f, 0xeef4f9)
    disc(1.7, (-1.0, 0, 3.6), 0x868ba1, segs=20, h=0.04)            # the pad, its H
    for dz in (-0.35, 0.35):
        box((0.9, 0.02, 0.14), (-1.0, 0.045, 3.6 + dz), 0xfff6eb)
    box((0.14, 0.02, 0.56), (-1.0, 0.045, 3.6), 0xfff6eb)
    # in the hover over its pad, coming in: on the pad it sat behind the road's
    # bank to its roof, and a racer saw a rotor and a tail
    with animated('anim_bob:h=0.22:p=4.6+sway:a=y:d=9:p=8.3#heli', (-1.0, 1.75, 3.6)):
        helicopter(-1.0, 1.75, 3.6, w=16.0)
        # the winch line down to the litter it is lifting off the pad
        box((0.05, 1.9, 0.05), (-1.0, 1.05, 3.6), 0x2a2735)
        box((0.6, 0.1, 0.24), (-1.0, 0.1, 3.6), 0xff7e44)
        box((0.5, 0.08, 0.16), (-1.0, 0.18, 3.6), 0xfff6eb)
    box((0.08, 1.6, 0.08), (1.0, 0.8, 0.9), 0x555b66)
    with animated('anim_sway:a=y:d=40:p=5.5#sock', (1.0, 1.55, 0.9)):
        box((0.06, 0.06, 0.06), (1.03, 1.55, 0.9), 0x2a2735)
        for k in range(4):
            c = 0xff5040 if k % 2 == 0 else 0xfff6eb
            cyl(0.1 - k * 0.012, 0.15, (1.06 + k * 0.15, 1.55 - k * 0.02, 0.9), c,
                r2=0.09 - k * 0.012, segs=8, axis='across', smooth=False)
    for sx in (-0.1, 0.1):                                         # the weather screen
        for sz in (-0.1, 0.1):
            box((0.05, 0.42, 0.05), (1.0 + sx, 0.21, -0.4 + sz), 0x555b66)
    box((0.28, 0.22, 0.28), (1.0, 0.53, -0.4), 0xfff6eb)
    box((0.34, 0.06, 0.34), (1.0, 0.67, -0.4), 0x555b66)
    for k in range(5):                                             # the snow stake
        box((0.08, 0.2, 0.08), (0.3, 0.1 + k * 0.2, 1.4), 0xff5040 if k % 2 == 0 else 0xfff6eb)
    sled(0.2, 0, 0.6, 0.4, 0xff7e44, L=0.6)
    snow_person(0.6, 0, -0.1, 0xff7e44, 0x38383d, yaw=0.4)
    snow_person(0.75, 0, 0.3, 0xff7e44, 0xcf534f, yaw=-0.3)
    MX, MZ, MH = -1.3, -1.7, 3.2                                   # the radio mast behind the hut,
    for i in range(8):                                             # banded, guyed, its aerials
        box((0.1, MH / 8, 0.1), (MX, MH / 8 * (i + 0.5), MZ), 0xff5040 if i % 2 == 0 else 0xfff6eb)
    box((0.7, 0.05, 0.05), (MX, MH - 0.1, MZ), 0x555b66)
    box((0.05, 0.05, 0.5), (MX, MH - 0.3, MZ), 0x555b66)
    for a in (0.9, 3.0, 5.1):
        strut((MX, MH * 0.7, MZ), (MX + 1.4 * math.cos(a), 0.02, MZ + 1.4 * math.sin(a)), 0.025, 0xc8cfdf)
    for (x, z) in ((0.72, -0.18), (0.88, 0.22)):                   # their probes
        box((0.04 + 0.02, 0.6, 0.04 + 0.02), (x, 0.3, z), 0x868ba1)
    snow_heap((-1.6, 0, 0.6), 0.6, yaw=0.2)

def woodpile(x, z, k=0.3):
    """Firewood stacked under a lean-to, cut ends to +X, an axe in the block
    beside it; `k` sizes it (0.3: a real woodpile)."""
    for row in range(3):
        for j in range(4 - row):
            zz = z + (-0.9 + j * 0.6 + row * 0.3) * k
            y = (0.3 + row * 0.52) * k
            cyl(0.3 * k, 2.2 * k, (x - 1.1 * k, y, zz), 0x8a6a46, segs=6, axis='across')
    for s in (-1, 1):
        box((0.2 * k, 2.4 * k, 0.2 * k), (x + 1.4 * k, 1.2 * k, z + s * 1.5 * k), 0x8a6a46)
        box((0.2 * k, 1.8 * k, 0.2 * k), (x - 1.4 * k, 0.9 * k, z + s * 1.5 * k), 0x8a6a46)
    snowy(box((3.4 * k, 0.2 * k, 3.5 * k), (x, 2.2 * k, z), 0xeef4f9, roll=-0.2))
    cyl(0.5 * k, 0.6 * k, (x + 2.4 * k, 0, z + 1.6 * k), 0x8a6a46, segs=8)

def log_cabin_at(cx, cz, k=1.0, smoke=False):
    """A log cabin at (cx, cz), door on +X, built at `k` of the old 4.2 unit
    cabin (0.55: a real cabin, two and a half units across): each wall its
    own logs whose ends cross out past the corners, a snowed gable roof, a
    stone chimney, lit windows."""
    W, D, H = 4.2 * k, 3.4 * k, 2.0 * k
    L = 0.4 * k                                    # a log
    box((W + 0.3 * k, 0.25 * k, D + 0.3 * k), (cx, 0.12 * k, cz), 0x868ba1)
    box((W - 0.2 * k, H, D - 0.2 * k), (cx, H / 2 + 0.1 * k, cz), 0x6e4a32)    # the chinking
    p = (H - 0.15 * k) / 4
    for j in range(4):
        for s in (-1, 1):
            box((L, L, D + 0.5 * k), (cx + s * (W / 2 - L / 2), 0.25 * k + (j + 0.5) * p, cz), 0x8a5a3a)
            if j < 3:
                box((W + 0.5 * k, L, L), (cx, 0.25 * k + (j + 1) * p, cz + s * (D / 2 - L / 2)), 0x9a5f3c)
    for s in (-1, 1):
        prism([(cz + D / 2 - 0.05 * k, H + 0.1 * k), (cz - D / 2 + 0.05 * k, H + 0.1 * k),
               (cz, H + 0.1 * k + (D / 2) * math.tan(0.6))], cx + s * (W / 2 - 0.1 * k), 0.2 * k, 0x8a5a3a)
    ridge = H + 0.1 * k + (D / 2) * math.tan(0.6)
    run = D / 2 + 0.45 * k
    for s in (-1, 1):
        snowy(box((W + 0.8 * k, 0.26 * k, run / math.cos(0.6) + 0.1 * k),
                  (cx, ridge - (run / 2) * math.tan(0.6) + 0.16 * k, cz + s * run / 2),
                  0xeef4f9, pitch=-s * 0.6), 0.5)
    box((W + 0.9 * k, 0.22 * k, 0.36 * k), (cx, ridge + 0.3 * k, cz), 0x868ba1)
    box((0.7 * k, 1.9 * k, 0.7 * k), (cx - 1.1 * k, ridge - 0.2 * k, cz - 0.75 * k), 0x868ba1)
    snowy(box((0.82 * k, 0.14 * k, 0.82 * k), (cx - 1.1 * k, ridge + 0.8 * k, cz - 0.75 * k), 0xeef4f9))
    if smoke:                                      # True, or the puffs' size (anim_smoke:s=)
        name = 'anim_smoke' if smoke is True else 'anim_smoke:s=%g' % smoke
        # each cabin's marker its own name: Blender would suffix a repeat
        marker('%s#%d' % (name, round(cz * 10)), (cx - 1.1 * k, ridge + 0.9 * k, cz - 0.75 * k))
    box((0.1 * k, 1.55 * k, 1.1 * k), (cx + W / 2 + 0.06 * k, 0.9 * k, cz - 0.55 * k), 0xfff6eb)
    box((0.1 * k, 1.35 * k, 0.85 * k), (cx + W / 2 + 0.12 * k, 0.82 * k, cz - 0.55 * k), 0x38383d)
    box((0.1 * k, 0.8 * k, 0.8 * k), (cx + W / 2 + 0.06 * k, 1.3 * k, cz + 0.95 * k), 0xfff6eb)
    box((0.1 * k, 0.6 * k, 0.6 * k), (cx + W / 2 + 0.12 * k, 1.3 * k, cz + 0.95 * k), 0xffc044)

@piece(1.0)
def log_cabin():
    # Flurry: a corner of the village below the lake at its real size beside
    # a car: a log cabin two and a half units across and two smaller ones
    # either side of it, their chimneys smoking (the columns stand over the
    # kerb from far down the road, before the cabins do), the woodpile under its
    # lean-to between them, a villager.
    log_cabin_at(0.0, 0.0, 0.58, smoke=1.5)
    log_cabin_at(-0.6, 3.0, 0.42, smoke=True)
    log_cabin_at(-0.4, -3.9, 0.48, smoke=True)
    woodpile(0.2, -2.2, 0.3)
    snow_person(1.8, 0, -0.6, 0x3f7bd9, 0xcf534f, yaw=-0.4)
    join_still('cabins')

def ramp(a, b, w, t, color):
    """A deck `w` wide and `t` thick under the line from glTF point a to b, its
    top on the line: a span of a ski jump's in-run."""
    dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    L = math.sqrt(dx * dx + dy * dy + dz * dz)
    h = math.hypot(dx, dz)
    nx, ny, nz = -dx * dy / (L * h), h / L, -dz * dy / (L * h)      # the deck's up
    mid = ((a[0] + b[0]) / 2 - nx * t / 2, (a[1] + b[1]) / 2 - ny * t / 2, (a[2] + b[2]) / 2 - nz * t / 2)
    return box((w, t, L), mid, color, yaw=math.atan2(dx, dz), pitch=math.atan2(dy, h))

# Flurry's ski jump lies on a hillside of the track's own land, so it levels
# nothing (a patch of its outrun drapes) and stands on the plain: every part
# is built from the ground as the renderer DRAWS it, sampled over the plain
# (the display's groundY less the layout's) every unit along the jump's axis
# from the outrun's end back up the hill, the highest across the in-run's
# width. Re-sample whenever the land or the piece moves.
JUMP_GROUND = ((12.0, 2.48), (11.0, 2.47), (10.0, 2.46), (9.0, 2.45), (8.0, 2.43), (7.0, 2.42), (6.0, 2.41), (5.0, 2.40), (4.0, 2.38), (3.0, 2.37), (2.0, 2.36), (1.0, 2.35), (0.0, 2.34), (-1.0, 2.33), (-2.0, 2.32), (-3.0, 2.31), (-4.0, 2.30), (-5.0, 2.29), (-6.0, 2.28), (-7.0, 2.27), (-8.0, 2.26), (-9.0, 2.42), (-10.0, 2.79), (-11.0, 3.17), (-12.0, 3.54), (-13.0, 3.91), (-14.0, 4.29), (-15.0, 4.66), (-16.0, 5.04), (-17.0, 5.41), (-18.0, 5.79), (-19.0, 6.16), (-20.0, 6.53), (-21.0, 6.91), (-22.0, 7.70), (-23.0, 8.52), (-24.0, 9.34), (-25.0, 10.15), (-26.0, 10.97), (-27.0, 11.79), (-28.0, 12.61), (-29.0, 13.43), (-30.0, 14.25), (-31.0, 15.07), (-32.0, 15.88), (-33.0, 16.70), (-34.0, 17.49), (-35.0, 18.22), (-36.0, 18.95), (-37.0, 19.69), (-38.0, 20.42), (-39.0, 21.15), (-40.0, 21.88), (-41.0, 22.62), (-42.0, 23.35), (-43.0, 24.08), (-44.0, 24.82))

def jump_ground(x):
    pts = JUMP_GROUND
    if x >= pts[0][0]:
        return pts[0][1]
    for (x0, h0), (x1, h1) in zip(pts, pts[1:]):
        if x >= x1:
            return h0 + (h1 - h0) * (x - x0) / (x1 - x0)
    return pts[-1][1]

@piece(1.0)
def ski_jump():
    # Flurry: the village's ski jump cut into the south shoulder of the massif
    # past the east loop (tracks.js flurry), flying out over the open
    # snowfield and away from every road, seen three-quarter from the front
    # off the crossing and the run in to the loop. The start hut on its
    # banded stub at the top, the in-run lying down the shoulder's steep upper
    # face on short legs, the table running out where the face eases to stop
    # in the air, its red front the lip, the landing down the gentler foot
    # and the outrun on the flat. Drawn in what a racer reads at speed against snow, pines and sky:
    # the in-run a dark steel girder between red side walls capped white,
    # standing off the hill on a braced trestle as it climbs; its tower
    # banded red and white like a mast, lit windows up it, the start hut
    # blue under snow with the start bar and a flag; the judges' tower blue, three glazed floors stepped back
    # under a red roof, seated in the far flank beside the landing; across
    # the landing the K line and the blue line, fir sprigs down its edges;
    # floodlight masts either side; the scoreboard and an arc of coloured
    # boards closing the outrun, flags at its end. A
    # jumper rides it every quarter minute (anim_path): down the in-run, a
    # flight over the foot, the landing, the outrun into the timing hut, then
    # back under the snow and up the hill to the start. +X the way the
    # jumpers fly, the in-run behind; y = 0 the plain, and every part runs
    # down through the hill to it, so it stands however the land is drawn.
    G = jump_ground
    T1, SPAN = -28.0, 10.0                 # the takeoff edge, and how far back up the slope the in-run reaches
    T0 = T1 - SPAN
    W = 2.4                                # the in-run's width
    # The in-run's line, from the takeoff back up: the table at 10 degrees
    # down, a short transition easing it to 40, then straight to the top. The
    # shoulder's upper face is about as steep as the straight, and the
    # takeoff stands a little below where it eases into the foot, so the
    # track keeps 0.8 over the ground at the least. The straight is steeper
    # than the shoulder, so the in-run stands away from the hill as it
    # climbs: at the top a tower's height over it, on a trestle of legs
    # braced corner to corner, the silhouette a ski jump is known by (lying
    # along the slope all the way it read as a slide down the hill).
    s1, s2 = math.tan(math.radians(44.0)), math.tan(math.radians(10.0))
    def slope(x):
        return s2 + (s1 - s2) * smooth01((T1 - 1.0 - x) / 2.5)
    def line(gap):
        pts = [(T1, G(T1) + gap)]
        x = T1
        while x > T0 + 1e-6:
            step = min(1.0, x - T0)
            pts.append((x - step, pts[-1][1] + slope(x - step / 2) * step))
            x -= step
        return pts
    run = line(max(0.9, max(G(x) - y for x, y in line(0.0)) + 0.8))
    run.reverse()                          # top to takeoff
    ytop = run[0][1]
    STEEL, RED, WHITE, SNOWT, BLUE, GLASS = 0x4f5260, 0xcf534f, 0xfff6eb, 0xf3f7fb, 0x3f7bd9, 0x2f3a4a
    # the girder (deep, so from the side the in-run is a band of red over
    # dark), its snow track and the side walls capped white, a span a unit.
    # Where the girder would meet the slope it runs on down into it, and the
    # track and the walls down to the ground as drawn: the in-run lies on the
    # hill, its red sides to the snow. The table, its last two units, is a
    # thinner slab run out from there over the foot, its lip in the air.
    # No two faces of different colours share a plane, nor come within the
    # far form's tolerance (TtpRenderer kFarTol) of one: there the dark
    # girder's side fought the red wall over it frame by frame. So the walls
    # are the in-run's sides, the girder runs narrower between them (its side
    # well back of theirs, the dark band under the red set in), the cap sits
    # on the wall's top instead of round it, and nothing here is thinner
    # than twice that tolerance, which would fold it flat onto a neighbour.
    WALL = 0.45                            # a side wall's thickness
    zw = W / 2 - WALL / 2                  # its middle
    for i, ((xa, ya), (xb, yb)) in enumerate(zip(run, run[1:])):
        lo = min(ya, yb)
        table = xa > T1 - 2.0 - 1e-6
        gmin, gmax = min(G(xa), G(xb)), max(G(xa), G(xb))
        near = not table and lo - 1.0 < gmax + 0.25
        sink = 1.25 * (lo - gmin + 0.5)                     # a pitched slab's depth to under the ground
        ramp((xa, ya, 0.0), (xb, yb, 0.0), W - 2 * WALL - 0.3, sink if near else 0.5 if table else 1.0, STEEL)
        # the track and the caps a hair past each end, so where the line
        # bends the spans still meet on top instead of baring the girder; the
        # track deep into the girder and under the walls' inner faces
        L = math.hypot(xb - xa, yb - ya)
        ex, ey = 0.06 * (xb - xa) / L, 0.06 * (yb - ya) / L
        ramp((xa - ex, ya - ey + 0.05, 0.0), (xb + ex, yb + ey + 0.05, 0.0), W - 2 * WALL + 0.2,
             sink if near else 0.45, SNOWT)
        # each wall on into its neighbours, so where the line bends up into
        # the table no wedge opens at the walls' feet onto the girder set in
        # behind them; the ends stay at the tower and the lip
        wa, wb = (0.3 if i > 0 else 0.0) / L, (0.3 if i < len(run) - 2 else 0.0) / L
        for s in (-1, 1):
            ramp((xa - wa * (xb - xa), ya - wa * (yb - ya) + 0.5, s * zw),
                 (xb + wb * (xb - xa), yb + wb * (yb - ya) + 0.5, s * zw), WALL, sink + 0.45 if near else 0.9, RED)
            ramp((xa - ex, ya - ey + 0.75, s * zw), (xb + ex, yb + ey + 0.75, s * zw), WALL + 0.1, 0.25, WHITE)
    # the takeoff's lip: the table's red front, in the air over the foot
    box((0.3, 1.1, W + 0.16), (T1 - 0.1, run[-1][1] + 0.05, 0.0), RED)
    # its legs, a pair across every two units back from the table's root,
    # down through the hill to the plain
    for x, y in run[2:-2:2]:
        for s in (-1, 1):
            box((0.3, y - 1.0, 0.3), (x, (y - 1.0) / 2, s * (W / 2 - WALL - 0.3)), STEEL)
        if y - 1.5 > G(x) + 0.3:                       # braced where it clears the hill
            box((0.18, 0.18, W - 2 * WALL - 0.3), (x, y - 1.4, 0.0), STEEL)
    # the trestle's bracing: each bay crossed corner to corner on both sides,
    # where the legs stand clear of the hill
    bays = run[2:-2:2]
    for (xa, ya), (xb, yb) in zip(bays, bays[1:]):
        if ya - 1.2 - G(xa) < 1.2:
            continue
        for s in (-1, 1):
            z = s * (W / 2 - WALL - 0.3)
            strut((xa, G(xa) + 0.1, z), (xb, yb - 1.2, z), 0.16, STEEL)
            strut((xa, ya - 1.2, z), (xb, max(G(xb) + 0.1, yb - 1.2 - (ya - 1.2 - G(xa))), z), 0.16, STEEL)
    # the start tower under the in-run's top, the jumpers' lift shaft, banded
    # red and white as a mast is, red at the top, from the plain up through
    # the hill
    top = ytop + 0.2
    g = min(G(T0 - 1.2), G(T0 + 1.2)) - 0.4
    n = max(2, round((top - g) / 1.4))
    for i in range(n):
        a, b = g + (top - g) * i / n, g + (top - g) * (i + 1) / n
        if i == 0:
            a = 0.0
        box((2.8, b - a, 2.8), (T0, (a + b) / 2, 0.0), RED if (n - 1 - i) % 2 == 0 else WHITE)
    # the start hut on its platform, a window down the in-run
    box((3.4, 0.24, 3.4), (T0, top - 0.12, 0.0), STEEL)
    box((2.0, 1.0, 2.0), (T0 - 0.4, top + 0.5, 0.0), BLUE)
    box((0.06, 0.4, 1.3), (T0 + 0.62, top + 0.62, 0.0), GLASS)
    box((2.2, 0.14, 2.2), (T0 - 0.4, top + 1.07, 0.0), STEEL)
    snowy(box((2.0, 0.14, 2.0), (T0 - 0.4, top + 1.2, 0.0), SNOWT), 0.4)
    for s in (-1, 1):                                  # its side windows, the shaft's lights below them
        box((1.2, 0.4, 0.06), (T0 - 0.4, top + 0.6, s * 1.01), GLASS)
        for i in range(n - 1):
            box((0.5, 0.5, 0.06), (T0, g + (top - g) * (i + 0.5) / n, s * 1.41), GLASS)
    for i in range(n - 1):
        box((0.06, 0.5, 0.5), (T0 + 1.41, g + (top - g) * (i + 0.5) / n, 0.0), GLASS)
    box((0.14, 0.14, W + 0.3), (T0 + 1.3, ytop + 0.95, 0.0), RED)               # the start bar
    for s in (-1, 1):
        box((0.12, 0.9, 0.12), (T0 + 1.3, ytop + 0.5, s * (W / 2 + 0.1)), STEEL)
    flag_across((T0 - 1.1, top + 1.2, 0.9), 1.3, RED, 'anim_sway:a=x:d=12:p=2.1#top')
    # the judges' cab seated in the far flank beside the landing (from the
    # road it stands clear of the in-run): a stem down through the hill to
    # the plain, the glazed box on it a unit over the flank as drawn there
    # (sampled), its glass to the landing and down the outrun
    jx, jz, jg = -18.0, -6.0, 5.6
    box((1.5, jg + 0.3, 1.4), (jx, (jg + 0.3) / 2, jz), 0x9a7b55)            # its timber foot, into the hill
    for lvl in range(3):                                                    # three glazed floors, stepped back
        y0 = jg + 0.3 + 0.78 * lvl
        w = 2.2 - 0.3 * lvl
        box((w + 0.2, 0.1, 1.9), (jx - 0.15 * lvl, y0 + 0.05, jz), WHITE)
        box((w, 0.68, 1.7), (jx - 0.15 * lvl, y0 + 0.44, jz), BLUE)
        box((w - 0.3, 0.36, 0.08), (jx - 0.15 * lvl, y0 + 0.5, jz + 0.85), GLASS)
        box((0.08, 0.36, 1.3), (jx - 0.15 * lvl + w / 2, y0 + 0.5, jz), GLASS)
    jy = jg + 0.3 + 0.78 * 3
    box((1.9, 0.16, 2.1), (jx - 0.3, jy + 0.08, jz), RED)
    snowy(box((1.7, 0.12, 1.9), (jx - 0.3, jy + 0.2, jz), SNOWT), 0.4)
    flag_across((jx - 0.9, jy + 0.2, jz - 0.6), 1.0, BLUE, 'anim_sway:a=x:d=12:p=2.6#judges')
    # What says "ski jump" round the landing. The ground off the axis is the
    # drawn ground as sampled there (it falls away across the outrun, from
    # the far flank to the road side), and every post runs down to the plain.
    def og(x, z):
        return 2.14 - 0.135 * z
    # the outrun's stop: an arc of boards in the village's colours
    BOARDS = (BLUE, WHITE, RED, 0xffc044, BLUE, WHITE, RED)
    zs = [-4.9 + 1.4 * i for i in range(8)]
    arc = [(10.0 - 0.1 * z * z, z) for z in zs]
    for k, ((xa, za), (xb, zb)) in enumerate(zip(arc, arc[1:])):
        mx, mz = (xa + xb) / 2, (za + zb) / 2
        yw = math.atan2(xb - xa, zb - za)
        L = math.hypot(xb - xa, zb - za)
        gy = min(og(xa, za), og(xb, zb))
        box((0.1, 0.75, L + 0.04), (mx, gy + 0.2, mz), BOARDS[k], yaw=yw)
        box((0.14, og(xa, za) + 0.75, 0.14), (xa, (og(xa, za) + 0.75) / 2 - 0.1, za), STEEL)
    xa, za = arc[-1]
    box((0.14, og(xa, za) + 0.75, 0.14), (xa, (og(xa, za) + 0.75) / 2 - 0.1, za), STEEL)
    # the scoreboard on the road side of the outrun, its face up the hill and
    # out to the road: the distance in lamps, the bib under it
    sx, sz = 5.0, 6.2
    sg = og(sx, sz)
    for e in (-0.9, 0.9):
        box((0.16, sg + 2.0, 0.16), (sx, (sg + 2.0) / 2, sz + e), STEEL)
    box((0.2, 1.3, 2.3), (sx, sg + 1.4, sz), 0x2a2735)
    for e, c in ((-0.7, 0xffc044), (0.0, 0xffc044), (0.7, 0xffc044)):
        box((0.26, 0.5, 0.42), (sx, sg + 1.62, sz + e), c)
    box((0.26, 0.24, 1.6), (sx, sg + 1.02, sz), WHITE)
    snowy(box((0.34, 0.1, 2.4), (sx, sg + 2.1, sz), SNOWT), 0.4)
    # floodlight masts either side of the landing, their racks turned to it
    for (fx, fz, fg) in ((-6.0, 7.6, 1.25), (-9.5, -8.6, 3.5)):
        top_y = fg + 5.0
        box((0.22, top_y, 0.22), (fx, top_y / 2, fz), STEEL)
        sgn = -1 if fz > 0 else 1
        box((1.5, 0.9, 0.14), (fx, top_y + 0.3, fz + sgn * 0.12), 0x868ba1)
        for i in range(3):
            for j in range(2):
                box((0.34, 0.28, 0.1), (fx - 0.48 + 0.48 * i, top_y + 0.1 + 0.4 * j, fz + sgn * 0.2), WHITE)
    # flags at the outrun's end, the road side's no nearer its kerb than the
    # outrun, each pole down through the land to the plain; the cloth two
    # units over the ground drawn there (sampled)
    for k, (fx, fz, gy, c) in enumerate(((4.5, -4.0, 2.68, RED), (4.5, 4.5, 1.53, BLUE),
                                         (3.0, -5.0, 2.81, BLUE), (3.0, 5.5, 1.4, RED))):
        flag_across((fx, -1.2, fz), gy + 3.4, c, 'anim_sway:a=x:d=12:p=%.1f#f%d' % (2.3 + 0.3 * k, k))
    # The jumper's loop: down the in-run on its snow, off the takeoff and
    # over the foot to the landing, the outrun, then under the snow back up
    # the hill to the tower and up inside it to the start.
    XL = -17.5
    pts = [(x, y + 0.18, 0.0) for x, y in run[1:]]
    y0 = run[-1][1] + 0.18
    for k in range(1, 8):
        f = k / 8.0
        x = T1 + (XL - T1) * f
        pts.append((x, (1 - f) ** 2 * y0 + (1 - (1 - f) ** 2) * (G(x) + 0.12) + 1.0 * math.sin(math.pi * f) ** 1.5, 0.0))
    for x in (XL, -14.5, -11.5, -8.5, -4.0):
        pts.append((x, G(x) + 0.12, 0.0))
    # the outrun turns off into the timing hut at its side, and the way back
    # runs from in there under the snow
    hx, hz, hy = 3.0, -3.8, 2.68
    pts += [(1.5, G(1.5) + 0.12, -1.6), (hx, hy + 0.12, hz), (hx - 0.3, hy - 1.8, hz)]
    for x in (-3.0, -8.0, -13.0, -18.0, -23.0, -28.0, -33.0, T0):
        pts.append((x, G(x) - 1.8, 0.0))
    pts.append((T0, ytop - 0.6, 0.0))
    for k, p in enumerate(pts):
        marker('path_jump_%d' % k, p)
    # the timing hut on the outrun's side, on the ground drawn there
    # (sampled), its walls run down to the plain
    box((1.5, hy + 0.2, 1.3), (hx, hy / 2 - 0.1, hz), 0x9a7b55)
    cabin_hut(1.5, 1.0, 1.3, (hx, hy, hz), 0x9a7b55, 0xeef4f9, yaw=math.pi / 2)
    for k in range(2):
        x, y, z = pts[3]
        with animated('anim_path:c=jump:p=30:o=%.2f:f=2#j%d' % (0.5 * k, k), (x, y, z)):
            skier(x, y - 0.18, z, (RED, BLUE)[k], WHITE)
    # a patch of snow at the outrun's end laid under the land as drawn (out
    # of sight, clear of the ground's depth), so the jump stands on the plain
    # and levels nothing
    def lines():
        box((0.6, 0.1, 0.6), (4.0, -0.25, 0.0), SNOWT)
        box((0.3, 0.06, 5.6), (-17.0, 0.03, 0.0), RED)                       # the K line
        box((0.3, 0.06, 5.6), (-13.5, 0.03, 0.0), BLUE)
        for s in (-1, 1):                                                   # fir sprigs down the landing's edges
            for k in range(11):
                box((0.5, 0.06, 0.14), (-25.0 + 1.6 * k, 0.03, s * 3.0), 0x61cb8b)
    draped('patch', lines)

# ---- snow companions: small scenes that carry a track's story round its lap ----

def kid_skier(x, y, z, coat, hat, k=0.8):
    """A child on skis toward +X, ski tips together in a snowplough: the
    skis, legs, a coat, a head in a helmet, `k` of a grown skier's size.
    Joined into one moving part by its caller."""
    def b(size, dx, dy, dz, color, yaw=0.0):
        box([q * k for q in size], (x + dx * k, y + dy * k, z + dz * k), color, yaw=yaw)
    for sd in (-1, 1):
        b((0.42, 0.04, 0.07), 0.02, 0.02, sd * 0.09, 0x2a2735, yaw=sd * 0.28)   # the plough
    b((0.1, 0.16, 0.16), 0.0, 0.12, 0, 0x38383d)
    b((0.14, 0.17, 0.18), 0.01, 0.28, 0, coat)
    b((0.1, 0.1, 0.1), 0.02, 0.42, 0, 0xf2bf99)
    b((0.12, 0.07, 0.12), 0.01, 0.5, 0, hat)

@piece(1.0)
def ski_school():
    # Powder: the ski school on its nursery slope by the road, at its real
    # size. The slope is the track's terrain (SET_GROUND: a low hill behind,
    # -X, its gentle face to the road), and on it the school's day goes round:
    # the children ride the magic carpet up the slope standing on their skis,
    # inside its covered gallery as a nursery slope's carpet runs, step off at
    # the top and snowplough down in a line through their little slalom, out
    # under the red and blue arch and on round the slope's face, a little
    # downhill all the way, to the carpet's foot (one loop, a child's slow
    # pace). Nothing climbs in sight: uphill they ride the belt, hidden in its
    # tunnel, and the run's foot IS the carpet's, its lowest point, so no
    # child skis back up to it. At the foot the school's red hut, its skis
    # racked, the instructor watching and two tall feather flags by the road,
    # the colour that says "ski school" from a car going by. All of it lies
    # on the slope as the renderer draws it (draped, the children's loop a
    # `drape` chain) but the hut, which stands level.
    H = set_ground('ski-school')
    COATS = (0xcf534f, 0x3f7bd9, 0x61cb8b, 0xffc044, 0xa878e8, 0xff7e44)
    CZ, C0, C1 = -1.6, 1.0, -20.0                                    # the carpet: its line, foot, head
    GATES = [(-18.8 + 1.4 * i, 3.5 if i % 2 == 0 else 1.2) for i in range(13)]       # the long run: thirteen gates
    AX, AZ = -0.4, 2.3                                               # the finish arch
    ARCHES = ((-16.6, 2.4, 1.3), (-12.4, 2.4, 1.3), (-8.3, 2.4, 1.3), (-4.2, 2.4, 1.3), (AX, AZ, 1.5))    # two more to ski through on the way down
    def static():
        for z in (-0.55, 0.55):                                       # the ski rack
            box((0.06, 0.34, 0.06), (2.5, 0.17, z - 2.6), 0x9a7b55)
        box((0.06, 0.06, 1.2), (2.5, 0.31, -2.6), 0x9a7b55)
        for k, c in enumerate((0xff5040, 0x339cf2, 0x22c46e, 0xffc044)):
            z = -3.05 + k * 0.28
            for e in (-0.035, 0.035):
                box((0.06, 0.44, 0.06), (2.56, 0.22, z + e), c, roll=-0.18)
        # the magic carpet: its belt and a step at each end (its gallery hides
        # the rest)
        n = 24
        xs = [C0 + (C1 - C0) * i / n for i in range(n + 1)]
        verts = [(x, 0.06, CZ + e) for x in xs for e in (-0.24, 0.24)]
        poly(verts, [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(n)], 0x38383d)
        for x in (C0 + 0.35, C1 - 0.35):
            box((0.5, 0.08, 0.7), (x, 0.04, CZ), 0x868ba1)
        # its gallery: a tunnel of pale panels over the belt on green hoops,
        # open at both ends, tall enough for a child on skis, a span a panel
        # so it lies on the slope as drawn
        RT, PANELS = 0.62, 4
        ts = [C0 - 0.05 + (C1 - C0 + 0.1) * i / n for i in range(n + 1)]
        half = math.pi / PANELS / 2
        chord, rm = 2 * RT * math.sin(half), RT * math.cos(half)
        with plain_parts():
            for xa, xb in zip(ts[:-1], ts[1:]):
                for j in range(PANELS):
                    t = (2 * j + 1) * half
                    box((abs(xb - xa) + 0.02, 0.05, chord + 0.02), ((xa + xb) / 2, rm * math.sin(t), CZ + rm * math.cos(t)),
                        0xd0e8ff, pitch=t - math.pi / 2)
            for x in ts:
                for j in range(PANELS):
                    t = (2 * j + 1) * half
                    box((0.1, 0.08, chord + 0.06), (x, (rm + 0.04) * math.sin(t), CZ + (rm + 0.04) * math.cos(t)),
                        0x61cb8b, pitch=t - math.pi / 2)
        for k, (gx, gz) in enumerate(GATES):                          # the children's slalom
            box((0.07, 0.6, 0.07), (gx, 0.3, gz), 0xfff6eb)
            box((0.05, 0.24, 0.34), (gx, 0.46, gz + 0.17), (0xff7e44, 0x3f7bd9)[k % 2])
        for n_, (ax_, az_, R) in enumerate(ARCHES):                   # the arches, banded in two colours
            cols = ((0x3f7bd9, 0xffc044), (0xff7e44, 0xfff6eb), (0xffc044, 0x61cb8b), (0xa878e8, 0xffc044), (0xff5040, 0x3f7bd9))[n_]
            for i in range(7):
                t = (i + 0.5) / 7 * math.pi
                box((0.42, 0.42, R * math.pi / 7 + 0.04), (ax_, R * math.sin(t), az_ + R * math.cos(t)),
                    cols[i % 2], pitch=t - math.pi / 2)
        # the run's edge marked down the fall line: a rope of bunting on short
        # poles along the outside of the slalom, and a mogul or two to hop
        for i in range(14):
            x = -19.3 + 1.45 * i
            box((0.06, 0.5, 0.06), (x, 0.25, 4.6), 0x555b66)
            if i < 13:
                box((0.04, 0.16, 0.16), (x + 0.5, 0.42, 4.6), (0xff5040, 0xffc044, 0x3f7bd9, 0x61cb8b)[i % 4])
                box((1.45, 0.04, 0.04), (x + 0.72, 0.48, 4.6), 0xfff6eb)
        for (mx, mz) in ((-15.0, 0.1), (-10.6, -0.1), (-7.0, 0.0), (-3.6, -0.2)):
            snowy(box((0.9, 0.3, 0.7), (mx, 0.1, mz), 0xf3f7fb, yaw=0.3), 0.45)
        for fz in (-0.9, 4.2):                                         # feather flags' poles by the road
            box((0.06, 1.5, 0.06), (3.0, 0.75, fz), 0x555b66)
        snow_person(1.8, 0, 2.6, 0xcf534f, 0xfff6eb, yaw=math.pi)         # the instructor, watching
        snow_heap((-0.2, 0, -4.4), 0.5, yaw=0.6)
    draped('school', static)
    # the hut level on the slope, its floor at the slope's top corner and a
    # stone footing under its front: draped, a house leaned with the hill
    hy = max(H(1.4 + dx, -3.4 + dz) for dx in (-0.7, 0.7) for dz in (-0.55, 0.55))
    box((1.5, 1.2, 1.2), (1.4, hy - 0.6, -3.4), 'grey')
    cabin_hut(1.4, 0.8, 1.1, (1.4, hy, -3.4), 0xcf534f, 0xeef4f9)
    # the feather flags' cloth, swinging round its pole as the wind shifts
    for n, (fz, c) in enumerate(((-0.9, 0xff5040), (4.2, 0x3f7bd9))):
        with animated('anim_drape+sway:a=y:d=18:p=%.1f#flag%d' % (2.3 + 0.4 * n, n), (3.0, 0.95, fz)):
            box((0.04, 1.0, 0.36), (3.0, 0.95, fz + 0.2), c)
            box((0.05, 0.12, 0.2), (3.0, 0.75, fz + 0.2), 0xfff6eb)
    # the children's loop: up the carpet inside its gallery, off at the head,
    # down through the gates, under the arch, round the face of the slope
    # (each point a little further from the summit than the last, so a
    # little lower) to the carpet's foot
    loop = [(C0 + 0.1, 0.08, CZ), (C1 + 0.2, 0.08, CZ), (C1 - 0.6, 0.02, CZ + 0.8), (C1 - 0.3, 0.02, 2.4)]
    for k, (gx, gz) in enumerate(GATES):
        loop.append((gx, 0.02, gz + (-0.4 if k % 2 == 0 else 0.4)))
    loop += [(AX - 0.7, 0.02, AZ), (AX + 0.5, 0.02, AZ), (0.95, 0.02, 0.85), (1.15, 0.02, -0.55)]
    for k, pt in enumerate(loop):
        marker('path_drapekids_%d' % k, pt)
    for n in range(10):
        at = loop[n]
        with animated('anim_path:c=drapekids:p=100:o=%.3f:f=1#%d' % (n / 10, n), at), plain_parts():
            kid_skier(at[0], at[1], at[2], COATS[n % 6], COATS[(n + 3) % 6], k=1.1)

def snowman(at, k=1.0, hat=False):
    """Three blocks of snow, coal eyes and buttons, a carrot facing +X, stick
    arms, a scarf: built the way the cars are, in chunky blocks, `k` sizing
    all of it (0.15: a real snowman, half a unit tall)."""
    x, y, z = at
    snowy(box((1.4 * k, 1.2 * k, 1.4 * k), (x, y + 0.6 * k, z), 0xf3f7fb, yaw=0.2), 0.5)
    snowy(box((1.05 * k, 0.9 * k, 1.05 * k), (x, y + 1.65 * k, z), 0xf3f7fb, yaw=-0.1), 0.5)
    snowy(box((0.8 * k, 0.75 * k, 0.8 * k), (x, y + 2.5 * k, z), 0xf3f7fb), 0.5)
    box((1.15 * k, 0.2 * k, 1.15 * k), (x, y + 2.12 * k, z), 0xff5040)
    box((0.45 * k, 0.16 * k, 0.16 * k), (x + 0.6 * k, y + 2.45 * k, z), 0xff7e44)
    for s2 in (-1, 1):
        box((0.14 * k, 0.14 * k, 1.0 * k), (x, y + 1.85 * k, z + s2 * 0.95 * k), 0x7a5a3a, pitch=s2 * 0.45)
    if hat:
        box((0.95 * k, 0.1 * k, 0.95 * k), (x, y + 2.92 * k, z), 0x2a2735)
        box((0.6 * k, 0.55 * k, 0.6 * k), (x, y + 3.25 * k, z), 0x2a2735)

def snow_ball(r, at, squash=0.9):
    """A rolled ball of snow, round (a block at this size read as a crate)."""
    return snowy(sphere(r, at, 0xf3f7fb, subdiv=1, scale=(1.0, squash, 1.0), flat=False), 0.35)

def snowfolk(x, z, h, yaw=0.0, hat=None, hat_c=0x2a2735, scarf=0xff5040, arms='out', balls=3, lean=0.0,
             broom=False, buttons=0x38383d):
    """One of the snowman field's crowd at (x, z), `h` tall, its carrot to +X
    turned by `yaw`: `balls` rolled balls (two for a child's), coal eyes and
    buttons, a carrot, stick arms (`arms`: out, up, down or none), a scarf
    in its own colour and a hat of its own kind (`hat`: top, bucket, bobble,
    cone or none); `lean` tips the head off its body, `broom` stands one in
    its hand. No two of the crowd are the same build."""
    c, s2 = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + dx * c + dz * s2, dy, z - dx * s2 + dz * c)
    rs = (0.3, 0.22, 0.16) if balls == 3 else (0.3, 0.19)
    k = h / (1.62 * sum(rs))
    rs = [r * k for r in rs]
    y, cy = -0.06 * k, []
    for r in rs:
        cy.append(y + r * 0.86)
        y += r * 1.62
    for i, r in enumerate(rs):
        off = lean * k if i == len(rs) - 1 else 0.0
        snow_ball(r, at(0.0, cy[i], off))
    hr, hy, hz = rs[-1], cy[-1], lean * k
    # the carrot: a short cone out of the middle of the face, its root in the
    # head (a bar as long as the head, square at the tip, read as a stick
    # through it from the road)
    cyl(0.3 * hr, 0.62 * hr, at(hr * 0.78, hy - 0.04 * hr, hz), 0xff7e44, r2=0.03, segs=6, axis='across', yaw=yaw,
        stem=True)
    for sd in (-1, 1):
        box((0.06, 0.07 * k, 0.07 * k), at(hr * 0.88, hy + 0.3 * hr, hz + sd * 0.38 * hr), 0x2a2735, yaw=yaw)
    for i in range(2 if balls == 3 else 1):
        box((0.06, 0.08 * k, 0.08 * k), at(rs[-2] * 0.97, cy[-2] + (0.25 - 0.5 * i) * rs[-2], 0.0), buttons, yaw=yaw)
    # the scarf: a band round the neck and an end hanging down the front
    ny = cy[-1] - hr * 0.82
    box((hr * 1.7, 0.11 * k, hr * 1.7), at(0.0, ny, hz * 0.6), scarf, yaw=yaw)
    box((0.07, 0.3 * k, 0.12 * k), at(hr * 0.86, ny - 0.14 * k, hz * 0.6 + 0.3 * hr), scarf, yaw=yaw)
    ar, ay = rs[-2], cy[-2] + 0.15 * rs[-2]
    L = 0.42 * k
    if arms != 'none':
        tip = {'out': 0.25, 'up': 0.95, 'down': -0.5}[arms]
        for sd in (-1, 1):
            box((0.06, 0.06, L), at(0.0, ay + math.sin(tip) * L / 2 * (1 if sd == 1 or arms != 'out' else 0.4),
                                    sd * (ar * 0.9 + math.cos(tip) * L / 2)), 0x7a5a3a, yaw=yaw, pitch=sd * tip)
    if broom:
        bz = ar * 0.9 + L * 0.9
        box((0.06, 0.95 * h, 0.06), at(0.0, 0.47 * h, bz), 0x8a6a46, yaw=yaw)
        box((0.1, 0.22 * k, 0.26 * k), at(0.0, 0.95 * h, bz), 0xffc044, yaw=yaw)
    top = hy + hr * 0.78
    if hat == 'top':
        box((hr * 2.0, 0.06, hr * 2.0), at(0.0, top, hz), hat_c, yaw=yaw)
        box((hr * 1.25, hr * 1.1, hr * 1.25), at(0.0, top + hr * 0.55, hz), hat_c, yaw=yaw)
        box((hr * 1.3, 0.06, hr * 1.3), at(0.0, top + hr * 0.2, hz), 0xff5040, yaw=yaw)
    elif hat == 'bucket':
        cyl(hr * 0.8, hr * 0.95, at(0.0, top - 0.05 * k, hz), hat_c, r2=hr * 0.6, segs=8, stem=True)
    elif hat == 'bobble':
        cyl(hr * 0.95, hr * 0.7, at(0.0, top - 0.12 * k, hz), hat_c, r2=hr * 0.5, segs=8, stem=True)
        box((0.14 * k, 0.14 * k, 0.14 * k), at(0.0, top + hr * 0.62, hz), 0xfff6eb, yaw=yaw)
    elif hat == 'cone':
        cyl(hr * 0.7, hr * 1.5, at(0.0, top - 0.06 * k, hz), hat_c, r2=0.03, segs=6, stem=True)

@piece(1.0)
def snowman_field():
    # Powder: where the resort's children have been at it all week. A field
    # of snowmen by the road, a crowd of two dozen facing it, no two alike:
    # a giant in the middle with a bucket on its head and a broom, families
    # in rows from the tall one down to the smallest, some with their arms
    # up, one with its head rolled off beside it, a pair leaning together, a
    # snow dog and a snow cat, one only begun (the big ball, the next beside
    # it, the shovel stood in the snow), and what the builders left: a sled,
    # a bucket of coal, a heap of spare snowballs. The little ones stand at
    # the front by the road, the tall ones behind, so a car going by sees
    # every row. Built on y = 0 and laid on the snow as drawn (draped).
    R, B, G, Y, P, O, D, W = 0xff5040, 0x3f7bd9, 0x61cb8b, 0xffc044, 0xa878e8, 0xff7e44, 0x2a2735, 0xfff6eb
    def build():
        F = (  # x (to the road), z, height, yaw, hat, hat colour, scarf, arms, balls, lean, broom
            (-2.6, 0.2, 2.1, 0.05, 'bucket', 0x868ba1, R, 'out', 3, 0.0, True),      # the giant
            (-3.4, -3.4, 1.35, 0.3, 'top', D, B, 'up', 3, 0.0, False),
            (-3.2, 3.6, 1.45, -0.25, 'bobble', R, G, 'out', 3, 0.0, False),
            (-4.6, 1.9, 1.2, -0.1, 'cone', P, Y, 'down', 3, 0.0, False),
            (-4.8, -1.4, 1.25, 0.15, 'top', D, O, 'out', 3, 0.05, False),
            (-1.0, -2.3, 1.1, 0.2, 'bobble', B, Y, 'up', 3, 0.0, False),             # a family, tall to small
            (-0.5, -3.3, 0.9, 0.3, 'bobble', G, R, 'out', 3, 0.0, False),
            (0.1, -4.2, 0.68, 0.4, 'bobble', Y, B, 'out', 2, 0.0, False),
            (0.6, -4.9, 0.5, 0.5, None, D, P, 'none', 2, 0.0, False),
            (-0.9, 2.6, 1.05, -0.2, 'top', D, P, 'out', 3, 0.0, True),
            (-0.2, 3.8, 0.95, -0.35, 'cone', O, B, 'up', 3, 0.0, False),
            (0.9, 1.5, 0.75, -0.05, 'bucket', R, G, 'out', 2, 0.0, False),
            (1.3, -0.4, 0.62, 0.1, 'bobble', P, O, 'up', 2, 0.0, False),
            (0.3, 0.3, 0.85, 0.0, None, D, R, 'down', 3, -0.06, False),              # a pair leaning together
            (0.3, -0.55, 0.9, 0.0, 'cone', G, Y, 'down', 3, 0.06, False),
            (1.9, 3.0, 0.55, -0.4, 'top', D, R, 'out', 2, 0.0, False),
            (2.2, -2.6, 0.58, 0.45, 'bucket', B, Y, 'out', 2, 0.0, False),
            (-5.9, -3.6, 1.1, 0.35, 'bobble', O, P, 'out', 3, 0.0, False),
            (-6.1, 0.4, 1.3, 0.0, 'top', D, G, 'up', 3, 0.0, False),
            (-5.7, 4.4, 1.0, -0.4, None, D, B, 'out', 3, 0.0, False),
            (-2.0, 5.6, 0.8, -0.5, 'bucket', 0x868ba1, O, 'down', 3, 0.0, False),
            (-2.2, -5.8, 0.85, 0.55, 'cone', R, G, 'out', 3, 0.0, False),
        )
        for (fx, fz, h, yw, hat, hc, sc, arms, balls, lean, broom) in F:
            snowfolk(fx, fz, h, yaw=yw, hat=hat, hat_c=hc, scarf=sc, arms=arms, balls=balls, lean=lean, broom=broom)
        # the one that lost its head: the body standing, the head in the snow
        snow_ball(0.36, (2.8, 0.26, 0.9))
        snow_ball(0.26, (2.8, 0.78, 0.9))
        snow_ball(0.19, (3.35, 0.12, 1.45))
        cyl(0.06, 0.14, (3.5, 0.14, 1.5), 0xff7e44, r2=0.02, segs=6, axis='across', yaw=-0.6, stem=True)
        # the snow dog and the snow cat
        for (ax_, az_, c_) in ((3.2, -1.2, R), (1.6, 4.6, Y)):
            snow_ball(0.2, (ax_, 0.15, az_))
            snow_ball(0.2, (ax_ - 0.3, 0.15, az_))
            snow_ball(0.15, (ax_ + 0.22, 0.36, az_))
            for sd in (-1, 1):
                snowy(box((0.07, 0.12, 0.07), (ax_ + 0.22, 0.52, az_ + sd * 0.08), 0xf3f7fb), 0.5)
            box((0.1, 0.06, 0.06), (ax_ + 0.38, 0.35, az_), 0x2a2735)
            box((0.26, 0.06, 0.28), (ax_ + 0.12, 0.27, az_), c_)
            snowy(box((0.3, 0.07, 0.07), (ax_ - 0.55, 0.2, az_), 0xf3f7fb, roll=-0.5), 0.5)
        # the one only begun, and what the builders left
        snow_ball(0.42, (3.4, 0.3, -3.9))
        snow_ball(0.3, (4.2, 0.2, -3.2))
        box((0.06, 0.8, 0.06), (3.9, 0.4, -4.6), 0x8a6a46)
        box((0.24, 0.26, 0.06), (3.9, 0.12, -4.6), 0x868ba1)
        sled(4.0, 0, 3.6, 0.5, R, L=0.7)
        cyl(0.14, 0.2, (3.3, 0.0, 4.2), 0x868ba1, r2=0.17, segs=8, stem=True)
        box((0.2, 0.05, 0.2), (3.3, 0.2, 4.2), 0x2a2735)
        for i in range(5):
            snow_ball(0.12, (4.4 + 0.2 * (i % 3), 0.08 + 0.17 * (i // 3), -1.0 + 0.2 * (i % 2)))
    draped('field', build)

def penguin(x, y, z, k=0.46, yaw=0.0, flippers=True):
    """A penguin standing at (x, y, z), beak to +X turned by `yaw`, `k` tall:
    a penguin beside a car is under half a unit. Feet, a dark body with its
    white front, the head and beak, the flippers. A live one is joined into
    one moving part by its caller."""
    u = k / 0.47
    c, s2 = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + dx * c + dz * s2, y + dy, z - dx * s2 + dz * c)
    box((0.22 * u, 0.29 * u, 0.2 * u), at(0, 0.2 * u, 0), 0x2a2735, yaw=yaw)             # body
    box((0.16 * u, 0.13 * u, 0.15 * u), at(0.01 * u, 0.405 * u, 0), 0x2a2735, yaw=yaw)   # head
    with plain_parts():                                  # too thin for a chamfer to show
        box((0.18 * u, 0.06, 0.16 * u), at(0.03 * u, 0.03, 0), 0xff7e44, yaw=yaw)        # feet
        box((0.06, 0.23 * u, 0.16 * u), at(0.1 * u, 0.19 * u, 0), 0xfff6eb, yaw=yaw)     # white front
        box((0.08 * u, 0.06, 0.06), at(0.11 * u, 0.39 * u, 0), 0xff7e44, yaw=yaw)        # beak
        if flippers:
            for sd in (-1, 1):
                box((0.12 * u, 0.18 * u, 0.06), at(0, 0.22 * u, sd * 0.12 * u), 0x2a2735, yaw=yaw,
                    pitch=sd * 0.25)

def slider_penguin(x, y, z, k=0.45, yaw=0.0):
    """A penguin on its belly toward +X turned by `yaw`, `k` long, the pivot
    under the middle of its belly: the body flat, the head up to see where it
    is going (the beak and the white face say "penguin" from above), flippers
    out."""
    u = k / 0.45
    c, s2 = math.cos(yaw), math.sin(yaw)
    def b(size, dx, dy, dz, color):
        box(size, (x + dx * c + dz * s2, y + dy, z - dx * s2 + dz * c), color, yaw=yaw)
    b((0.36 * u, 0.13 * u, 0.2 * u), 0, 0.075 * u, 0, 0x2a2735)                   # body
    b((0.26 * u, 0.06, 0.17 * u), 0.02 * u, 0.035, 0, 0xfff6eb)                    # belly
    b((0.15 * u, 0.14 * u, 0.15 * u), 0.2 * u, 0.17 * u, 0, 0x2a2735)              # head, up
    b((0.06, 0.1 * u, 0.12 * u), 0.28 * u, 0.16 * u, 0, 0xfff6eb)                  # face
    b((0.08 * u, 0.06, 0.06), 0.32 * u, 0.15 * u, 0, 0xff7e44)                     # beak
    for sd in (-1, 1):
        b((0.14 * u, 0.06, 0.1 * u), -0.02 * u, 0.07 * u, sd * 0.15 * u, 0x2a2735)  # flipper out
    b((0.08 * u, 0.06, 0.12 * u), -0.21 * u, 0.03, 0, 0xff7e44)                    # feet behind

# The standing penguins' life (set_motion.h): rock on their feet out of step,
# turn to watch a car coming (radii in world units), a little hop as one
# passes close.
PENGUIN = 'anim_waddle+watch:r=30+hop:r=14:h=0.12#%d'

def stood_penguin(x, z, k, yaw, y=0.0):
    """A penguin of a crowd: three blocks (the dark body with its head, the
    white front, the beak), which is what reads of one among many."""
    u = k / 0.47
    c, s2 = math.cos(yaw), math.sin(yaw)
    def at(dx, dy):
        return (x + dx * c, y + dy, z - dx * s2)
    box((0.22 * u, 0.44 * u, 0.2 * u), at(0, 0.22 * u), 0x2a2735, yaw=yaw)
    with plain_parts():                                  # too thin for a chamfer to show
        box((0.06, 0.26 * u, 0.16 * u), at(0.1 * u, 0.17 * u), 0xfff6eb, yaw=yaw)
        box((0.08 * u, 0.06, 0.06), at(0.13 * u, 0.36 * u), 0xff7e44, yaw=yaw)

# A CROWD of penguins, every one of them alive, at the cost of a few moving
# parts: it stands in KNOTS of a few close together, each knot one part
# that rocks on its feet (waddle) about the line its members stand along and
# face, so each of them rocks from foot to foot as a lone penguin does. The
# knots keep their own pace and phase, the members their own sizes and turns
# (a chick among them, one lying on its belly that wriggles as the rest
# rock). A frozen penguin beside a moving one reads as a broken toy, and one
# part a penguin is too many draws for a crowd. Each member stands on the
# piece's own ground (SET_GROUND, `H`) as it lies round the knot's middle and
# the knot is draped there (`drape`): a knot is small enough that the drawn
# slope under it is the authored one, its uphill members held to a hand's
# breadth over its middle (set-check's floor under a draped part).
KNOT_SLOTS = {   # (along the knot's line, across it) of each member, by size
    2: ((-0.2, -0.1), (0.2, 0.12)),
    3: ((-0.31, 0.09), (0.0, -0.16), (0.31, 0.1)),
    4: ((-0.34, -0.14), (-0.05, 0.2), (0.12, -0.19), (0.36, 0.11)),
    5: ((-0.35, 0.0), (-0.1, -0.24), (-0.06, 0.24), (0.2, -0.02), (0.39, 0.22)),
    6: ((-0.35, -0.21), (-0.02, -0.25), (0.32, -0.19), (-0.25, 0.19), (0.08, 0.22), (0.38, 0.17)),
}

def penguin_knot(tag, cx, cz, yaw, n, H, seed, lying=False, file=False, apart=True):
    """A knot of `n` penguins round (cx, cz) facing +X turned by `yaw` (their
    line); `file` stands them one behind another down the line, a step apart
    (a line of them across a slope stands level along it). `apart`, each is
    a part of its own with a life of its own: it rocks on its feet at its
    own pace and lean, and most do one thing more now and then, out of step
    with the rest (a slow look round and back, a little hop, a shuffle
    round on the spot); each lies on the land under its own feet. Not
    `apart` (the lite build), the knot is ONE part that rocks together about
    its line, the cost of a crowd on the box."""
    slots = [(0.38 * (j - (n - 1) / 2), 0.07 * (-1) ** j) for j in range(n)] if file else KNOT_SLOTS[n]
    def member(j, x, y, z):
        f = (seed * 3 + j * 7) % 11 / 10.0
        if lying and j == n - 1:
            slider_penguin(x, y, z, 0.4, yaw)
        elif (seed + 2 * j) % 7 == 3:
            stood_penguin(x, z, 0.34, yaw + (f - 0.5) * 0.5, y)          # a chick
        else:
            stood_penguin(x, z, 0.42 + 0.06 * f, yaw + (f - 0.5) * 0.5, y)
    if not apart:
        h0 = H(cx, cz)
        d, p = 6 + seed * 5 % 4, 1.15 + 0.12 * (seed * 3 % 7)
        with animated('anim_drape+waddle:d=%d:p=%.2f#%s' % (d, p, tag), (cx, 0.0, cz), yaw):
            for j, (a, l) in enumerate(slots):
                x, z = turned(cx, cz, yaw, a, l)
                member(j, x, min(0.08, H(x, z) - h0), z)
        return
    for j, (a, l) in enumerate(slots):
        x, z = turned(cx, cz, yaw, a, l)
        q = seed * 7 + j * 13                     # this one's own numbers
        own = 'waddle:d=%d:p=%.2f' % (5 + q % 6, 0.95 + 0.11 * (q * 5 % 9))
        if lying and j == n - 1:
            own = 'waddle:d=%d:p=%.2f' % (3 + q % 3, 1.7 + 0.2 * (q % 4))   # resting: a slow wriggle
        elif q % 4 == 0:
            own += '+sway:a=y:d=%d:p=%.1f:r=%.2f' % (28 + q % 5 * 6, 4.5 + q % 7, 0.55 + 0.05 * (q % 5))
        elif q % 4 == 1:
            own += '+bob:h=%.2f:p=%.1f:r=%.2f' % (0.05 + 0.01 * (q % 4), 3.2 + q % 6 * 0.9, 0.86)
        elif q % 4 == 2:
            own += '+sway:a=y:d=%d:p=%.1f' % (10 + q % 4 * 3, 6.0 + q % 5 * 1.3)
        with animated('anim_drape+%s#%s%d' % (own, tag, j), (x, 0.0, z), yaw):
            member(j, x, 0.0, z)

def penguin_group_build(apart):
    # Glacier: a rookery of penguins on a snow slope by the ice, at their own
    # size beside a car (under half a unit tall). The slope is the track's
    # terrain (SET_GROUND: a low hill behind, -X, its face to the road), and
    # the crowd stands up its face, knot over knot, so from a car going by it
    # reads as one crowd rather than a line along the kerb: some four dozen,
    # most facing +X, a few lying on their bellies and a chick or two among
    # them, every one of them rocking on its feet (penguin_knot). Two at the
    # front turn to watch a car coming and hop as one passes close, and a
    # pair wanders a loop round the rookery's edge, one behind the other
    # (anim_path facing its way, rocking from foot to foot as it goes). All of
    # it lies on the slope as the renderer draws it (draped, the walkers' loop
    # a `drape` chain). Each placement's yaw turns +X to the racer where the
    # lap reads it best.
    H = set_ground('penguin-group')
    CX, RX, RZ, K = -2.8, 4.5, 4.4, 11
    for i in range(K):
        # a sunflower spread over an oval, so the knots are even without a grid
        r, a = math.sqrt((i + 0.5) / K), i * 2.39996 + 0.4
        x, z = CX + RX * 0.92 * r * math.cos(a), RZ * 0.92 * r * math.sin(a)
        if x > 0.0 and abs(z) < 1.5:
            z = 1.5 if z >= 0 else -1.5                            # room for the live ones in front
        h = math.sin(i * 12.9898) * 0.5 + 0.5
        penguin_knot('k%d' % i, x, z, (h - 0.5) * 0.9 + 0.3 * math.sin(i * 3.1), 4 + i % 3, H, i,
                     lying=i % 4 == 2, apart=apart)
    draped('rookery', lambda: snow_heap((CX - 3.2, 0, 2.6), 0.5, yaw=0.5))
    for n, (x, z, k, yaw) in enumerate(((1.4, 0.35, 0.46, 0.0), (1.2, -0.45, 0.44, 0.3))):
        with animated('anim_drape+' + PENGUIN[5:] % (n + 1), (x, 0, z), yaw):
            penguin(x, 0, z, k, yaw)
    M = 14
    pts = [(CX + math.cos(a) * (RX + 0.8), 0.0, math.sin(a) * (RZ + 0.7))
           for a in (j / M * 2 * math.pi for j in range(M))]
    for j, pt in enumerate(pts):
        marker('path_drapewalk_%d' % j, pt)
    for k in range(2):
        # built sunk under the snow, pivot and all: the path carries the pivot
        # onto the drawn slope, and at rest no part stands over a capped ground
        at = (pts[k][0], -0.6, pts[k][2])
        with animated('anim_path:c=drapewalk:p=40:o=%.3f:f=1+waddle:d=12:p=0.5#%d' % (k * 0.05, k), at):
            penguin(at[0], at[1], at[2], 0.44, 0.0)

@piece(1.0)
def penguin_group():
    penguin_group_build(True)

@piece(1.0)
def penguin_group_lite():
    # the box's rookery: the knots rock as one part each
    penguin_group_build(False)

def penguin_chute_build(apart):
    # Glacier: the colony's toboggan hill. The hill is the track's terrain
    # (SET_GROUND: a snow hill some seven units tall, its summit well back from
    # the road, -X, its long face toward it), and this is what lies on it, at
    # the penguins' own size: the slide worn down that face, a packed-ice
    # groove between two lips of snow, running out across the flat into a
    # hole of open water in the ice by the road (+X). Penguins come over the
    # crest on their bellies, toboggan the length of it and shoot into the
    # water; more climb out of the hole and trudge up the hill's flank in a
    # line, waddling, to go over the top for another go; the rest of the
    # colony stands on the face beside the slide, line over line, watching,
    # rocking on its feet as every penguin here does. Both loops close
    # out of sight (under the hill, under the ice): a slider comes up just
    # behind the crest, a climber goes down behind it, so a racer sees them
    # go in and come out, never jump. Everything is DRAPED: built from y = 0
    # as if on the plain and laid on the terrain as the renderer draws it,
    # the paths too (`drape` chains), so nothing floats off the grid's chords.
    TOP, HOLE = -19.0, 3.0                                            # the summit, the water hole
    def static():
        n = 56                                                        # fine: it bends at the grid's folds
        xs = [TOP + 0.6 + (HOLE - 1.4 - TOP - 0.6) * i / n for i in range(n + 1)]
        verts, faces = [], []
        for i, x in enumerate(xs):                                    # the groove, a strip of ice
            for z in (-0.42, 0.42):
                verts.append((x, 0.06, z))
        faces = [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(n)]
        poly(verts, faces, 0xbcd8f5)
        for sd in (-1, 1):                                            # its lips of snow
            for (xa, xb) in zip(xs[:-1:6], xs[6::6]):
                # low: a lip a hand higher hid the ice from a car that sees the slide side-on
                snowy(box((xb - xa + 0.1, 0.09, 0.18), ((xa + xb) / 2, 0.035, sd * 0.52), 0xf3f7fb), 0.45)
        # The hole the slide ends in: open water in a hole in the ice. Nothing
        # here can go under the ground, so the ICE stands over the water: a
        # shelf of ice round an uneven opening, its top a hand over the
        # water, its inner wall showing the ice's thickness in a deeper blue,
        # snow lying on its outer half and running out to nothing; the dark
        # water inside, a step down. The shelf dips to the water where the
        # slide runs in (toward -X), so the groove meets it with no wall
        # across. Water, wall and shelf are one polar mesh on shared rings
        # and spokes: each vertex lies on the land as drawn, and two flat
        # discs a hair apart (as this was) cut through each other wherever
        # the ground's grid folded under them.
        N, WY, TOPY = 28, 0.035, 0.17
        def rim(a):                                                   # the opening's uneven edge
            return 1.32 * (1.0 + 0.09 * math.sin(2 * a + 0.7) + 0.06 * math.sin(3 * a + 2.1) + 0.04 * math.sin(5 * a))
        def gate(a):                                                  # 0 where the slide runs in, 1 elsewhere
            d = abs(math.atan2(math.sin(a - math.pi), math.cos(a - math.pi)))
            return smooth01((d - 0.32) / 0.3)
        rows = []
        for i in range(N + 1):
            a = i / N * 2 * math.pi
            c, sn = math.cos(a), math.sin(a)
            r0 = rim(a)
            top = WY + 0.02 + (TOPY - WY - 0.02) * gate(a)
            out = r0 + 0.62 + 0.14 * math.sin(4 * a + 1.0)
            prof = [(0.0, WY), (0.45 * r0, WY), (0.8 * r0, WY), (r0, WY),            # the water
                    (r0 + 0.07, top), (r0 + 0.3, top + 0.01),                         # the wall, the bare ice
                    (out, top * 0.75), (out + 0.4, -0.04)]                            # the snow on it, down to the land
            rows.append([(HOLE + c * r, y, sn * r) for r, y in prof])
        def pool_color(i, j, nn):
            return ('water', 'water', 'water', 'wall', 'ice', 'snow', 'snow')[j]
        polys = {}
        for i in range(N):
            for j in range(7):
                polys.setdefault(pool_color(i, j, None), []).append(
                    [rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]])
        for kind, quads in polys.items():
            o = colored_faces([({'snow': 'white', 'water': 'blue'}.get(kind, 'sky'), q) for q in quads], 'pool')[0]
            for pl in o.data.polygons:                       # all of it faces up
                if pl.normal.z < 0:
                    pl.flip()
            if kind == 'water':
                rowed(o, 17)                                 # deep water: well down the blue ramp, short of its violet end
            elif kind == 'wall':
                rowed(o, 27)                                 # the ice's thickness: the sky ramp's deep end
            else:
                snowy(o, 0.45 if kind == 'snow' else 0.3)
    draped('chute', static)
    # the watchers, every one alive (penguin_knot): two knots at the water's
    # edge facing the road, one lying on its belly to rest, two on the top,
    # and the colony on the hill's face beside the slide, line over line,
    # each line turned to the slide to watch (along the face, so it stands
    # level across it)
    H = set_ground('penguin-chute')
    penguin_knot('w0', HOLE + 1.75, 1.85, -0.5, 3, H, 1, apart=apart)
    penguin_knot('w1', HOLE + 1.95, -1.75, 0.5, 4, H, 4, lying=True, apart=apart)
    penguin_knot('w2', TOP, -1.6, 0.2, 2, H, 2, apart=apart)
    for i in range(7):
        r, a = math.sqrt((i + 0.5) / 7), i * 2.39996 + 0.9
        x, z = -6.5 + 5.2 * r * math.cos(a), -4.7 + 2.3 * r * math.sin(a)
        penguin_knot('c%d' % i, x, z, -math.pi / 2 + 0.2 * math.sin(i * 2.7), 5 + i % 3, H, i + 5,
                     lying=i % 3 == 1, file=True, apart=apart)
    # On the water: two floes of broken ice riding it, rocking a little, and
    # where the sliders go in a ring spreading (a pale ring that rises
    # through the surface and sinks again, in time with nothing).
    for n, (fx, fz, w, yw) in enumerate(((HOLE + 0.45, 0.55, 0.5, 0.4), (HOLE + 0.2, -0.75, 0.36, 1.3))):
        with animated('anim_drape+bob:h=0.025:p=%.1f+sway:a=y:d=7:p=%.1f#floe%d' % (2.6 + 0.7 * n, 7.0 + 2 * n, n),
                      (fx, 0.0, fz)):
            snowy(cyl(w, 0.11, (fx, 0.02, fz), 0xd0e8ff, segs=5, yaw=yw, stem=True), 0.3)
            snowy(cyl(w * 0.8, 0.04, (fx, 0.12, fz), 0xf3f7fb, segs=5, yaw=yw, stem=True), 0.45)
    RX = HOLE - 0.55
    with animated('anim_drape+bob:h=0.05:p=2.9#ripple', (RX, 0.0, 0.0)):
        ring = [[(RX + math.cos(a) * r, 0.0, math.sin(a) * r) for r in (0.42, 0.52)]
                for a in (i / 14 * 2 * math.pi for i in range(15))]
        for o in sheet(ring, lambda i, j, nn: 0xd0e8ff, 'ring'):
            snowy(o, 0.3)
    # the sliders' loop: up out of the snow behind the crest, over it and down
    # the groove, across the flat and into the water, home under the ice and
    # the hill
    slide = [(TOP - 4.0, -1.2, 0.0), (TOP - 1.8, 0.05, 0.0)]
    x = TOP - 0.6
    while x < HOLE - 1.0:
        slide.append((x, 0.07, 0.0))
        x += 1.0
    slide += [(HOLE - 0.5, 0.0, 0.0), (HOLE + 0.2, -0.9, 0.0)]
    slide += [(HOLE - 1.0 - 2.0 * i, -1.6, -0.6) for i in range(int((HOLE - TOP + 2.0) / 2.0))]
    for k, pt in enumerate(slide):
        marker('path_drapeslide_%d' % k, pt)
    for n in range(4):                            # spread round the loop; the renderer moves them
        x = TOP + 2.0 + 4.0 * n
        with animated('anim_path:c=drapeslide:p=13:o=%.3f#%d' % (n / 4, n), (x, 0.07, 0.0)), plain_parts():
            slider_penguin(x, 0.07, 0.0, 0.5)
    # the climbers' loop: out of the water, up the flank in a line, over the
    # top and down behind it, home under the hill; uphill no faster than the
    # colony's walkers go on the flat
    climb = [(HOLE + 0.3, -0.7, 0.9), (HOLE - 0.35, 0.19, 1.5), (HOLE - 1.1, 0.02, 2.5), (0.0, 0.0, 3.2), (-4.5, 0.0, 5.2),
             (-9.0, 0.0, 5.8), (-13.5, 0.0, 4.6), (-17.0, 0.0, 2.6), (TOP - 0.6, 0.0, 1.2),
             (TOP - 2.6, 0.0, 0.9), (TOP - 4.2, -1.3, 0.9)]
    climb += [(TOP - 2.0 + 4.0 * i, -1.7, 2.6) for i in range(1, int((HOLE - TOP + 2.0) / 4.0))]
    for k, pt in enumerate(climb):
        marker('path_drapeclimb_%d' % k, pt)
    for n in range(3):
        at = climb[2 + n]
        with animated('anim_path:c=drapeclimb:p=90:o=%.3f:f=1+waddle:d=12:p=0.46#%d' % (n / 3, n), at), plain_parts():
            stood_penguin(at[0], at[2], 0.47, 0.0)

@piece(1.0)
def penguin_chute():
    penguin_chute_build(True)

@piece(1.0)
def penguin_chute_lite():
    # the box's toboggan hill: the watchers' knots rock as one part each
    penguin_chute_build(False)

def ridge_tent(x, z, color, k=0.27, yaw=0.0):
    """A ridge tent at (x, z), its door to +X turned by `yaw`; `k` sizes it
    (0.27: a two-person tent, under a unit long)."""
    c, s2 = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + dx * c + dz * s2, dy, z - dx * s2 + dz * c)
    for sd in (-1, 1):
        box((3.2 * k, 0.06, 1.9 * k), at(0, 0.72 * k, sd * 0.66 * k), color, yaw=yaw, pitch=-sd * 0.86)
    box((3.4 * k, 0.06, 0.06), at(0, 1.46 * k, 0), 0x2a2735, yaw=yaw)
    for e in (-1, 1):                                               # the gable ends
        poly([at(e * 1.52 * k, 0.02, 1.28 * k), at(e * 1.52 * k, 0.02, -1.28 * k),
              at(e * 1.52 * k, 1.42 * k, 0)], [(0, 1, 2)], color)
    poly([at(1.56 * k, 0.02, 0.5 * k), at(1.56 * k, 0.02, -0.5 * k), at(1.56 * k, 0.95 * k, 0)],
         [(0, 1, 2)], 0x2a2735)                                     # the door

def radio_mast(MX, MZ, MH, bands, flag):
    """The expedition's radio mast at (MX, MZ), `MH` tall in `bands` red and
    white bands, its aerials, three guys pegged out round it and the flag
    flying across (+Z) from its head, moved by `flag`."""
    for i in range(bands):
        box((0.1, MH / bands, 0.1), (MX, MH / bands * (i + 0.5), MZ), 0xff5040 if i % 2 == 0 else 0xfff6eb)
    box((0.7, 0.05, 0.05), (MX, MH - 0.1, MZ), 0x555b66)              # its aerials
    box((0.05, 0.05, 0.5), (MX, MH - 0.3, MZ), 0x555b66)
    for a in (0.6, 2.7, 4.8):
        gx, gz = MX + 1.5 * math.cos(a), MZ + 1.5 * math.sin(a)
        strut((MX, MH * 0.7, MZ), (gx, 0.02, gz), 0.025, 0xc8cfdf)
    flag_across((MX, MH, MZ), 0.45, 0xff5040, flag, w=0.62, fh=0.38, pole=0x555b66)

@piece(1.0)
def expedition_camp():
    # Glacier: a climbers' base camp at its real size beside a car: a cluster
    # of bright ridge tents (under a unit long) and the big blue mess tent
    # behind a curved wall of snow blocks against the wind, the radio mast
    # over them (some twelve metres, banded red and white, guyed: what reads
    # over the kerb from far down the road) flying the expedition's flag across
    # to the road, a long sled loaded with kit, rucksacks, two climbers. All
    # of it on the crest of its snow bank (SET_GROUND), up where a racer sees
    # it over the kerb, and draped: built on y = 0 and laid on the bank as the
    # renderer draws it.
    ridge_tent(0.0, 0.0, 0xff7e44)
    ridge_tent(-0.3, 0.9, 0xcf534f)
    ridge_tent(0.2, -0.95, 0xffc044)
    ridge_tent(0.9, 1.9, 0x61cb8b, yaw=-0.4)
    ridge_tent(1.0, -2.0, 0xff5040, yaw=0.5)
    ridge_tent(-1.4, -0.4, 0x3f7bd9, k=0.42, yaw=0.15)              # the mess tent
    for k in range(7):                                              # the wind wall, round the back
        a = -1.25 + k * 0.42
        # round the back of the mess tent, a clear half unit behind its gable
        snowy(box((0.2, 0.34, 0.6), (-0.3 - 2.55 * math.cos(a * 0.62), 0.17, 2.55 * math.sin(a * 0.62)), 0xf3f7fb,
                  yaw=a * 0.62), 0.4)
    sled(1.4, 0, 0.9, 0.3, 0x9a7b55, L=0.7)
    box((0.22, 0.12, 0.3), (1.42, 0.2, 0.9), 0x3f7bd9, yaw=0.3)     # its load
    for (x, z, c) in ((1.25, -0.35, 0xcf534f), (1.35, -0.15, 0x61cb8b)):
        box((0.12, 0.18, 0.1), (x, 0.09, z), c, yaw=0.3)
    snow_person(1.6, 0, -0.6, 0xcf534f, 0x38383d, yaw=0.5)
    snow_person(1.75, 0, 0.25, 0x3f7bd9, 0xffc044, yaw=-0.6)
    # the radio mast, banded, its guys pegged out round it
    MX, MZ, MH = -0.5, -2.2, 2.8
    radio_mast(MX, MZ, MH, 7, 'anim_drape+sway:a=x:d=24:p=1.9#1')
    # draped, the flag too (`drape`): the bank's crest is drawn on the 9 u
    # grid, half a unit and more off its flat top
    group([o for o in bpy.context.scene.objects if o.type == 'MESH' and o.get('anim') is None],
          'drape_camp')

@piece(1.0)
def advanced_camp():
    # Glacier: the expedition's advanced camp, a lap on from its base camp
    # and smaller, as a camp up the mountain is: four ridge tents in a row
    # and the store tent behind them, a short wall of snow blocks at the back,
    # no mess tent and no sled, the radio mast (what reads over the kerb)
    # flying the expedition's flag, two ice axes
    # stood in the snow, two climbers by the tents. Close set, on a low bank
    # (SET_GROUND), so the slope it stands near tips no tent: draped, built on
    # y = 0 and laid on the snow as the renderer draws it.
    for (z, c) in ((-1.3, 0xff7e44), (-0.43, 0xffc044), (0.43, 0xcf534f), (1.3, 0x3f7bd9)):
        ridge_tent(0.2, z, c)
    ridge_tent(-1.3, 0.0, 0x61cb8b, k=0.38, yaw=math.pi / 2)        # the store tent, behind
    for k in range(5):                                              # the wind wall behind them
        snowy(box((0.18, 0.3, 0.55), (-2.35, 0.15, -1.4 + k * 0.7), 0xf3f7fb, yaw=0.1 * (k - 2)), 0.4)
    for (x, z) in ((1.0, -0.2), (1.05, 0.05)):                      # ice axes stood in the snow
        box((0.04, 0.32, 0.04), (x, 0.16, z), 0x555b66)
        box((0.16, 0.04, 0.04), (x, 0.32, z), 0x2a2735)
    snow_person(1.2, 0, -0.9, 0x3f7bd9, 0xcf534f, yaw=0.4)
    snow_person(1.3, 0, 0.8, 0x61cb8b, 0x38383d, yaw=-0.5)
    MX, MZ, MH = -0.3, 2.3, 2.8
    radio_mast(MX, MZ, MH, 7, 'anim_drape+sway:a=x:d=24:p=1.7#1')
    group([o for o in bpy.context.scene.objects if o.type == 'MESH' and o.get('anim') is None],
          'drape_camp')

def ski_plane(x, y, z, prop, k=1.0):
    """The expedition's ski-plane facing +X, built round (x, y, z) on its
    skis, `k` times a bush plane at 2.6 long and 4.2 across the wing: a red
    fuselage with dark glass, a high wing on struts, the tail, white skis on
    their legs, and the propeller turning (`prop` names its spin, a part
    riding on the plane)."""
    RED, WHITE, DARK, GREY = 0xcf534f, 0xfff6eb, 0x2f3a4a, 0x555b66
    def at(dx, dy, dz):
        return (x + dx * k, y + dy * k, z + dz * k)
    def b(size, off, color, **kw):
        return box(tuple(e * k for e in size), at(*off), color, **kw)
    def st(p0, p1, t):
        strut(at(*p0), at(*p1), t * k, GREY)
    b((1.7, 0.55, 0.62), (0.15, 0.75, 0), RED)                 # the cabin
    b((0.7, 0.42, 0.5), (-0.95, 0.82, 0), RED, roll=-0.12)     # the tail cone
    b((0.5, 0.48, 0.58), (1.15, 0.72, 0), 0xa6413e)            # the cowl
    for sd in (-1, 1):
        b((0.7, 0.24, 0.04), (0.45, 0.86, sd * 0.32), DARK)    # the cabin's windows
    b((0.12, 0.26, 0.5), (0.82, 0.92, 0), DARK, roll=0.5)      # the windscreen
    b((0.62, 0.08, 4.2), (0.3, 1.08, 0), RED)                  # the high wing
    for sd in (-1, 1):
        b((0.14, 0.09, 0.5), (0.3, 1.13, sd * 1.9), WHITE)     # its tips
        st((0.35, 0.55, sd * 0.3), (0.32, 1.03, sd * 1.2), 0.05)
    b((0.42, 0.06, 1.5), (-1.25, 0.98, 0), RED)                # the tailplane
    b((0.42, 0.55, 0.06), (-1.3, 1.22, 0), RED, roll=0.2)      # the fin
    b((0.2, 0.3, 0.07), (-1.32, 1.3, 0), WHITE, roll=0.2)
    for sd in (-1, 1):                                         # skis on their legs
        st((0.3, 0.5, sd * 0.2), (0.3, 0.14, sd * 0.55), 0.06)
        b((1.3, 0.08, 0.2), (0.3, 0.08, sd * 0.55), WHITE)
        b((0.3, 0.08, 0.2), (1.0, 0.14, sd * 0.55), WHITE, roll=0.5)
    b((0.5, 0.06, 0.12), (-1.2, 0.32, 0), WHITE)               # the tail ski
    st((-1.1, 0.62, 0), (-1.2, 0.35, 0), 0.04)
    with animated(prop, at(1.44, 0.72, 0)):
        b((0.06, 1.1, 0.12), (1.45, 0.72, 0), DARK)            # the blades
        b((0.12, 0.12, 0.12), (1.47, 0.72, 0), GREY)           # the spinner

def arched_tent(x, z, W, D, H, color, yaw=0.0):
    """A hangar tent: canvas over hoops, open at its +X end (turned by
    `yaw`), `W` across, `D` deep, `H` tall."""
    c, s2 = math.cos(yaw), math.sin(yaw)
    N = 7
    for i in range(N):
        a0, a1 = math.pi * i / N, math.pi * (i + 1) / N
        lz0, ly0 = -W / 2 * math.cos(a0), H * math.sin(a0)
        lz1, ly1 = -W / 2 * math.cos(a1), H * math.sin(a1)
        pts = [(-D / 2, ly0, lz0), (D / 2, ly0, lz0), (D / 2, ly1, lz1), (-D / 2, ly1, lz1)]
        poly([(x + px * c + pz * s2, py, z - px * s2 + pz * c) for px, py, pz in pts], [(0, 1, 2, 3)], color)
    back = [(-D / 2, H * math.sin(math.pi * i / N), -W / 2 * math.cos(math.pi * i / N)) for i in range(N + 1)]
    poly([(x + px * c + pz * s2, py, z - px * s2 + pz * c) for px, py, pz in back], [tuple(range(N + 1))], color)
    for k in (-0.5, 0.0, 0.5):                                       # its hoops, dark
        for i in range(N):
            a0, a1 = math.pi * i / N, math.pi * (i + 1) / N
            p0 = (k * D, H * math.sin(a0) + 0.03, -W / 2 * math.cos(a0))
            p1 = (k * D, H * math.sin(a1) + 0.03, -W / 2 * math.cos(a1))
            strut((x + p0[0] * c + p0[2] * s2, p0[1], z - p0[0] * s2 + p0[2] * c),
                  (x + p1[0] * c + p1[2] * s2, p1[1], z - p1[0] * s2 + p1[2] * c), 0.06, 0x555b66)

def cargo_sledge(x, z, load):
    """An expedition's cargo sledge at (x, z), its nose to +X: two steel
    runners turned up at the front, a slatted deck on four posts, and its
    load lashed on: `crates` (boxes of stores under a green tarp, a red
    jerrycan) or `drums` (three fuel drums stood up, a strap round them)."""
    DARK, WOOD = 0x38383d, 0x9a7b55
    for sd in (-1, 1):
        box((1.7, 0.07, 0.08), (x, 0.035, z + sd * 0.36), DARK)
        box((0.3, 0.07, 0.08), (x + 0.95, 0.12, z + sd * 0.36), DARK, roll=-0.6)   # the turned-up tip
        for dx in (-0.6, 0.6):
            box((0.07, 0.2, 0.07), (x + dx, 0.14, z + sd * 0.36), DARK)
    box((1.6, 0.07, 0.86), (x, 0.27, z), WOOD)
    if 'crates' in load:
        box((0.6, 0.42, 0.62), (x - 0.42, 0.51, z), 0xfde4c7)
        box((0.5, 0.34, 0.5), (x + 0.2, 0.47, z - 0.12), 0x3f7bd9)
        box((0.66, 0.1, 0.68), (x - 0.42, 0.75, z), 0x61cb8b)           # the tarp over the stores
        box((0.2, 0.3, 0.14), (x + 0.6, 0.45, z + 0.2), 0xcf534f)       # a jerrycan
    if 'drums' in load:
        for i, (dx, dz) in enumerate(((-0.42, -0.18), (0.0, 0.16), (0.42, -0.18))):
            cyl(0.21, 0.56, (x + dx, 0.3, z + dz), (0xcf534f, 0x3f7bd9, 0xcf534f)[i], segs=10, stem=True)
            box((0.3, 0.05, 0.3), (x + dx, 0.87, z + dz), DARK)

@piece(1.0)
def glacier_airstrip():
    # Glacier: the expedition's airstrip on the snow inside the top loop,
    # beside the top straight under the range, at its real size beside a car:
    # a groomed runway with red and orange marker wands down both edges, the
    # red ski-plane taxiing up and down its east end with its propeller
    # turning (anim_path, a slow walk's pace, round at each end), and on its far side
    # the orange hangar tent, the fuel drums on their sledge, the radio mast
    # flying its flag, the red snowcat with its two sledges parked. Red and
    # orange on white, so it reads at speed. Placed at u 0.2, lat 9.5, yaw 0:
    # +X north toward the top straight, the strip along Z (east). It levels
    # its clearing: the snow inside the loop is flat already.
    L, Wd = 28.0, 3.0
    box((Wd, 0.08, L), (0.0, 0.04, 0.0), 0xdde9f6)                     # the groomed strip
    for k, zz in enumerate([-L / 2 + 2.0 * i for i in range(15)]):
        for sd in (-1, 1):
            if sd > 0 and k % 3:                # the road's side: every third, not a row of posts
                continue
            c = 0xff5040 if k % 2 == 0 else 0xff7e44
            box((0.12, 0.75, 0.12), (sd * (Wd / 2 + 0.35), 0.375, zz), c)
            box((0.04, 0.16, 0.26), (sd * (Wd / 2 + 0.35), 0.66, zz + 0.15), c)
    # the plane's loop, at the strip's east end, where the top straight looks
    # at it all the way along and the bend after it comes nearest: up one
    # side, round, back down the other
    pts = []
    for zz in [0.0 + 1.5 * i for i in range(10)]:
        pts.append((-0.5, 0.08, zz))
    zE = pts[-1][2]
    for i in range(1, 6):
        a = math.pi * i / 6
        pts.append((-0.5 + 0.5 * (1 - math.cos(a)), 0.08, zE + 1.6 * math.sin(a)))
    for zz in [zE - 1.5 * i for i in range(10)]:
        pts.append((0.5, 0.08, zz))
    zW = pts[-1][2]
    for i in range(1, 6):
        a = math.pi * i / 6
        pts.append((0.5 - 0.5 * (1 - math.cos(a)), 0.08, zW - 1.6 * math.sin(a)))
    for k, pt in enumerate(pts):
        marker('path_taxi_%d' % k, pt)
    x0, y0, z0 = pts[0]
    with animated('anim_path:c=taxi:p=40:f=1#plane', (x0, y0, z0)):
        ski_plane(x0, y0, z0, 'anim_spin:a=x:w=9#prop', k=1.35)
    # its camp on the far side of the strip
    arched_tent(-6.0, -6.0, 4.2, 3.4, 2.1, 0xff7e44, yaw=math.pi / 2)    # open to the strip
    sled(-4.6, 0.0, 3.0, 0.0, color=0x9a7b55, L=1.6)
    for i, (dx, dz) in enumerate(((-0.35, -0.2), (0.15, -0.2), (-0.1, 0.25), (0.4, 0.25))):
        cyl(0.2, 0.55, (-4.6 + dx, 0.16, 3.0 + dz), (0xcf534f, 0x3f7bd9)[i % 2], segs=10)
    radio_mast(-5.0, 9.0, 4.6, 9, 'anim_sway:a=x:d=20:p=1.9#flag')
    snowcat(-6.5, 0.0, -13.0, k=0.45)
    # its train: two cargo sledges on a drawbar each, loaded (two bare decks
    # end to end read as a brown beam it dragged)
    cargo_sledge(-8.75, -13.0, ('crates',))
    cargo_sledge(-10.95, -13.0, ('drums',))
    box((0.5, 0.07, 0.07), (-7.55, 0.2, -13.0), 0x38383d)             # the drawbars
    box((0.5, 0.07, 0.07), (-9.85, 0.2, -13.0), 0x38383d)

def frac(v):
    return v - math.floor(v)

def jitter(i, j, seed):
    """A hash in [-0.5, 0.5) per integer grid point: what a faceted form is jittered by."""
    return frac(math.sin(i * 12.9898 + j * 78.233 + seed * 3.17) * 43758.5453) - 0.5

def colored_faces(polys, name):
    """Faces [(colour, [glTF points, ...]), ...] as one object per colour."""
    buckets = {}
    for color, pts in polys:
        buckets.setdefault(color, []).append(pts)
    objs = []
    for color, fs in buckets.items():
        verts, faces = [], []
        for pts in fs:
            faces.append(tuple(range(len(verts), len(verts) + len(pts))))
            verts += pts
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(P(*v)) for v in verts], [], faces)
        me.update()
        o = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(o)
        objs.append(paint(o, color))
    return objs

def braking_mound(x, z, yaw=0.0, k=1.0, down=2.4):
    """An earth braking mound in an avalanche's runout, at its real size: a
    heap of earth a car and a half high, longer across the fall line than
    down it, its crest toward the slope (-X) so the face the slide strikes is
    steep and the back falls away long and gentle toward the road (`down`).
    Rounded and faceted like the kit's own hills, its rim sunk under the
    snow; the snow lies on its crown and back, the steep face shows its earth
    and the stones pitched into it. Built on the plain for a drape; turned by
    `yaw`."""
    H, UP, ALONG, SINK = 1.3 * k, 1.35 * k, 2.5 * k, 0.35
    RINGS, SEGS = 3, 12
    cx = -0.3 * k                                   # the crest, toward the slope
    def radius(a):
        c, s = math.cos(a), math.sin(a)
        rx = down * k if c > 0 else UP
        return 1.0 / math.sqrt((c / rx) ** 2 + (s / ALONG) ** 2)
    def point(i, j):
        if i == 0:
            lx, lz, y = cx, 0.0, H
        else:
            t = i / RINGS
            a = 2 * math.pi * j / SEGS
            r = radius(a) * t
            shape = 1.6 if math.cos(a) > 0 else 0.6      # a long back, a full steep face
            y = (H + SINK) * math.cos(t * math.pi / 2) ** shape - SINK
            if i < RINGS:
                y += 0.08 * jitter(i * 7 + j, int(x * 10), z)
            lx, lz = cx + math.cos(a) * r, math.sin(a) * r
        wx, wz = turned(x, z, yaw, lx, lz)
        return (wx, y, wz), lx
    polys = []
    def face(idx):
        pts = [point(i, j) for i, j in idx]
        p = [q[0] for q in pts]
        if len(p) == 3:
            u = [p[1][m] - p[0][m] for m in range(3)]
            v = [p[2][m] - p[0][m] for m in range(3)]
        else:
            u = [p[2][m] - p[0][m] for m in range(3)]
            v = [p[3][m] - p[1][m] for m in range(3)]
        n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        if n[1] < 0:
            p, n = p[::-1], tuple(-c for c in n)
        ny = n[1] / (math.sqrt(sum(c * c for c in n)) or 1.0)
        uphill = sum(q[1] for q in pts) / len(pts) < cx
        if ny < 0.74 and uphill:
            color = 'grey' if jitter(len(polys), 5, x + z) > 0.25 else 0x8a6a46   # earth, stones in it
        else:
            color = 0xf3f7fb
        polys.append((color, p))
    for j in range(SEGS):
        face([(0, 0), (1, j), (1, (j + 1) % SEGS)])
    for i in range(1, RINGS):
        for j in range(SEGS):
            face([(i, j), (i + 1, j), (i + 1, (j + 1) % SEGS), (i, (j + 1) % SEGS)])
    for o in colored_faces(polys, 'mound'):
        if o['swatch'] == 'white':
            snowy(o, 0.45)

@piece(1.0)
def avalanche_slope():
    # Avalanche: two of its slopes, the track's terrain (SET_GROUND: one
    # under the west slope by the turn onto the crossing, its forest and path
    # sampled on it; one in the cirque, whose ground the long gallery's cut
    # is sampled on), with the pines that stand on them. No snow fence on
    # them: at their range the fences were specks. A patch of snow lies
    # draped under the first pine, so the piece stands on the plain and
    # levels nothing.
    H = set_ground('avalanche-slope')
    for x, z, k in ((-14.0, -12.6, 1.8), (-19.6, 11.2, 1.9), (-30.8, -19.6, 1.8),
                    (-10.5, 7.5, 1.6), (-24.0, -4.0, 1.7)):
        pine((x, H(x, z) - 0.6, z), k)
    draped('patch', lambda: box((0.5, 0.1, 0.5), (-14.0, -0.06, -12.6), 0xf3f7fb))

@piece(1.0)
def warning_sign():
    # Avalanche: an avalanche warning at the foot of a path the slides come
    # down, on the verge a few units off the kerb where a racer reads it, at
    # its real size beside a car: a yellow diamond with the slope and its
    # tumbling snow on it, on a post beside a red and white marker pole.
    # Draped, so it stands on the verge as drawn.
    def sign():
        box((0.1, 1.3, 0.1), (0, 0.45, 0), 0x555b66)
        box((0.06, 0.62, 0.62), (0.04, 0.95, 0), 0x2a2735, pitch=math.pi / 4)
        box((0.06, 0.54, 0.54), (0.07, 0.95, 0), 0xffc044, pitch=math.pi / 4)
        prism([(0.17, 0.84), (-0.17, 0.84), (-0.04, 1.06)], 0.11, 0.03, 0x2a2735)
        for k in range(6):
            box((0.1, 0.24, 0.1), (0.0, 0.12 + k * 0.24, 0.7), 0xff5040 if k % 2 == 0 else 0xfff6eb)
        box((0.5, 0.18, 0.4), (-0.15, 0.0, 0.35), 0xf3f7fb)
    draped('sign', sign)

# ---- Avalanche: the galleries, and the cut in the mountainside they stand in ----
#
# The road runs under the mountains on the outside of the lap's last loop, in
# two stretches: the bend and the run to the slide's foot, then the straight
# after the slide. The mountainside is the track's terrain (tracks.js avalanche
# `land`, standing `near` the kerb); each stretch is one piece placed astride
# the road (lat 0, yaw 0): a snow shed over the road and the cut its foot was
# blasted back by. Both follow the road through its bends, which a rigid box
# cannot, so each piece carries the road's centreline in its own frame
# (ROAD_A, ROAD_B: (x, z, nx, nz, deck) a unit apart along the road, (nx, nz)
# the road's valley-ward normal, `deck` its height) and the land beside it
# (FACE_A, FACE_B). They were sampled from the built track
# (ttp_track_frames_json, and the drawn ground) at the placements tracks.js
# gives them, so they move together: re-sample if the road, the placement or
# the land does.

ROAD_A = (  # about u 0.825, from u 0.782 to 0.8687
    (3.868, -18.975, 0.7873, 0.6165, 0.36), (3.284, -18.168, 0.8202, 0.5721, 0.295),
    (2.737, -17.334, 0.8506, 0.5257, 0.23), (2.242, -16.467, 0.8792, 0.4764, 0.165),
    (1.799, -15.576, 0.9042, 0.427, 0.11), (1.393, -14.662, 0.9265, 0.3763, 0.063),
    (1.053, -13.723, 0.946, 0.3243, 0.03), (0.754, -12.771, 0.964, 0.266, -0.002),
    (0.524, -11.794, 0.9804, 0.1971, -0.013), (0.359, -10.809, 0.9905, 0.1375, -0.015),
    (0.24, -9.812, 0.9952, 0.0983, -0.01), (0.152, -8.816, 0.9966, 0.0818, 0.0),
    (0.083, -7.819, 0.998, 0.0629, 0.0), (0.03, -6.822, 0.9993, 0.0364, 0.0),
    (-0.0, -5.825, 0.9998, 0.0195, 0.0), (-0.012, -4.827, 1.0, 0.0079, 0.0),
    (-0.014, -3.82, 1.0, 0.0006, 0.0), (-0.007, -2.822, 1.0, -0.0038, 0.0),
    (-0.008, -1.825, 1.0, -0.0051, 0.0), (-0.0, -0.827, 1.0, -0.0036, 0.0),
    (-0.002, 0.174, 1.0, 0.0007, 0.0), (-0.004, 1.178, 1.0, 0.0081, 0.0),
    (-0.023, 2.176, 0.9996, 0.0293, 0.0), (-0.066, 3.173, 0.9988, 0.0492, 0.0),
    (-0.121, 4.17, 0.9982, 0.0592, 0.0), (-0.176, 5.177, 0.9981, 0.0619, 0.0),
    (-0.242, 6.173, 0.9984, 0.0562, 0.0), (-0.287, 7.171, 0.9992, 0.0411, 0.0),
    (-0.318, 8.168, 0.9999, 0.0167, 0.0), (-0.312, 9.165, 0.9998, -0.021, 0.0),
    (-0.269, 10.164, 0.9971, -0.0761, 0.0), (-0.156, 11.16, 0.9879, -0.1553, 0.0),
    (0.024, 12.142, 0.9799, -0.1994, 0.0), (0.244, 13.117, 0.9699, -0.2435, 0.0),
    (0.521, 14.079, 0.9517, -0.3071, 0.0), (0.872, 15.018, 0.9177, -0.3973, 0.0),
    (1.326, 15.904, 0.8547, -0.5192, 0.0), (1.915, 16.712, 0.7432, -0.669, 0.0),
    (2.651, 17.387, 0.6226, -0.7825, 0.0), (3.474, 17.955, 0.5018, -0.865, 0.0),
    (4.369, 18.39, 0.3777, -0.9259, 0.0))
ROAD_B = (  # about u 0.722, from u 0.682 to 0.7471
    (6.857, -15.798, 0.4878, 0.8729, 1.99), (6.019, -15.289, 0.5491, 0.8357, 1.837),
    (5.217, -14.716, 0.6078, 0.7941, 1.663), (4.457, -14.093, 0.6654, 0.7464, 1.484),
    (3.755, -13.41, 0.717, 0.6971, 1.289), (3.101, -12.675, 0.764, 0.6453, 1.094),
    (2.506, -11.901, 0.8097, 0.5868, 0.889), (1.975, -11.071, 0.8531, 0.5217, 0.716),
    (1.502, -10.21, 0.8898, 0.4563, 0.542), (1.095, -9.308, 0.9209, 0.3899, 0.384),
    (0.76, -8.379, 0.9475, 0.3197, 0.246), (0.492, -7.419, 0.9721, 0.2346, 0.146),
    (0.314, -6.436, 0.9893, 0.1462, 0.079), (0.202, -5.446, 0.9959, 0.0908, 0.036),
    (0.126, -4.446, 0.9975, 0.0709, 0.006), (0.07, -3.445, 0.9989, 0.0474, -0.015),
    (0.031, -2.446, 0.9996, 0.0286, -0.03), (0.016, -1.448, 0.9999, 0.0156, -0.04),
    (0.003, -0.452, 1.0, 0.0043, -0.05), (0.005, 0.55, 1.0, -0.005, -0.05),
    (0.016, 1.551, 0.9999, -0.014, -0.05), (0.032, 2.549, 0.9997, -0.023, -0.045),
    (0.056, 3.549, 0.9994, -0.0332, -0.04), (0.098, 4.548, 0.9989, -0.0459, -0.03),
    (0.154, 5.546, 0.998, -0.0637, -0.01), (0.221, 6.541, 0.997, -0.0775, 0.014),
    (0.3, 7.543, 0.9955, -0.0947, 0.048), (0.408, 8.532, 0.9911, -0.1333, 0.091),
    (0.562, 9.525, 0.981, -0.1939, 0.144), (0.782, 10.489, 0.9647, -0.2634, 0.207),
    (1.074, 11.453, 0.947, -0.3212, 0.272))
# The ground beside each gallery's road as the renderer draws it (the cut
# stands in front of it, cut_face): per sample of ROAD_A / ROAD_B, the
# display's groundY over the plain at FACE_L hill-ward of the centreline
# along the sample's normal. The land, the road and the band all shape it.
FACE_L = (4, 4.5, 5, 5.5, 6.5, 7, 7.5, 8, 9, 10, 11, 12, 13.5)
FACE_A = (
    (0.3, 0.2, 0.1, 0.1, 0.1, 0.4, 0.8, 1.1, 1.9, 2.7, 3.3, 3.8, 4.4), (0.2, 0.1, 0.1, 0.1, 0.1, 0.5, 0.9, 1.2, 2.1, 3.0, 3.8, 4.3, 5.0),
    (0.2, 0.1, 0.1, 0.1, 0.1, 0.7, 1.2, 1.6, 2.7, 3.7, 4.5, 5.1, 5.9), (0.1, 0.1, 0.1, 0.1, 0.1, 0.7, 1.4, 1.9, 3.0, 4.3, 5.2, 5.8, 6.7),
    (0.1, 0.1, 0.1, 0.1, 0.1, 0.6, 1.3, 1.9, 3.2, 4.5, 5.8, 6.5, 7.4), (0.1, 0.1, 0.1, 0.1, 0.1, 1.0, 1.7, 2.4, 3.9, 5.3, 6.6, 7.2, 8.2),
    (0.1, 0.1, 0.1, 0.1, 0.1, 1.0, 2.0, 2.7, 4.3, 6.0, 7.2, 7.9, 8.9), (0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 1.9, 2.8, 4.5, 6.2, 7.9, 8.5, 9.6),
    (0.1, 0.1, 0.1, 0.1, 0.1, 1.1, 2.1, 3.0, 4.9, 6.6, 8.4, 9.1, 10.1), (0.1, 0.1, 0.1, 0.1, 0.2, 1.3, 2.3, 3.2, 5.1, 7.0, 8.7, 9.5, 10.6),
    (0.1, 0.1, 0.1, 0.1, 0.1, 1.2, 2.3, 3.3, 5.2, 7.2, 8.9, 9.7, 10.9), (0.1, 0.1, 0.1, 0.1, 0.1, 1.1, 2.2, 3.3, 5.3, 7.2, 9.0, 9.9, 11.1),
    (0.1, 0.1, 0.1, 0.1, 0.1, 1.0, 2.1, 3.2, 5.3, 7.2, 9.1, 10.0, 11.2), (0.1, 0.1, 0.1, 0.1, 0.1, 1.1, 2.2, 3.3, 5.4, 7.3, 9.2, 10.1, 11.3),
    (0.1, 0.1, 0.1, 0.1, 0.1, 1.1, 2.2, 3.3, 5.4, 7.3, 9.2, 10.1, 11.3), (0.1, 0.1, 0.1, 0.1, 0.1, 1.1, 2.2, 3.3, 5.4, 7.3, 9.2, 10.1, 11.4),
    (0.1, 0.1, 0.1, 0.1, 0.1, 1.0, 2.1, 3.3, 5.3, 7.3, 9.2, 10.1, 11.4), (0.1, 0.1, 0.1, 0.1, 0.1, 1.0, 2.1, 3.2, 5.3, 7.3, 9.2, 10.0, 11.3),
    (0.1, 0.1, 0.1, 0.1, 0.1, 1.0, 2.1, 3.2, 5.3, 7.3, 9.2, 10.0, 11.2), (0.1, 0.1, 0.1, 0.1, 0.1, 1.0, 2.1, 3.2, 5.3, 7.3, 9.2, 10.0, 11.2),
    (0.1, 0.1, 0.1, 0.1, 0.1, 1.0, 2.1, 3.2, 5.3, 7.3, 9.2, 10.0, 11.1), (0.1, 0.1, 0.1, 0.1, 0.1, 1.0, 2.1, 3.2, 5.3, 7.2, 9.2, 10.0, 11.1),
    (0.1, 0.1, 0.1, 0.1, 0.1, 1.0, 2.1, 3.2, 5.3, 7.2, 9.2, 9.9, 11.0), (0.1, 0.1, 0.1, 0.1, 0.2, 1.0, 2.1, 3.2, 5.3, 7.3, 9.2, 9.9, 11.0),
    (0.1, 0.1, 0.1, 0.2, 0.2, 1.0, 2.2, 3.3, 5.4, 7.3, 9.3, 10.0, 10.9), (0.1, 0.2, 0.2, 0.2, 0.2, 1.1, 2.2, 3.3, 5.4, 7.4, 9.3, 10.0, 11.0),
    (0.2, 0.2, 0.2, 0.2, 0.2, 1.2, 2.3, 3.4, 5.5, 7.5, 9.4, 10.0, 11.0), (0.2, 0.2, 0.2, 0.2, 0.2, 1.2, 2.3, 3.4, 5.5, 7.5, 9.4, 10.0, 11.0),
    (0.2, 0.2, 0.2, 0.2, 0.2, 1.2, 2.3, 3.4, 5.5, 7.5, 9.5, 10.1, 11.0), (0.2, 0.2, 0.2, 0.2, 0.2, 1.1, 2.2, 3.3, 5.5, 7.4, 9.4, 10.1, 11.0),
    (0.2, 0.2, 0.2, 0.2, 0.2, 1.3, 2.4, 3.5, 5.6, 7.5, 9.4, 10.4, 11.3), (0.2, 0.2, 0.2, 0.2, 0.3, 1.3, 2.4, 3.4, 5.5, 7.3, 9.2, 10.3, 11.6),
    (0.2, 0.2, 0.2, 0.2, 0.2, 1.2, 2.3, 3.3, 5.2, 7.1, 9.0, 10.0, 11.6), (0.2, 0.2, 0.2, 0.2, 0.9, 1.5, 2.5, 3.5, 5.1, 7.0, 8.8, 9.6, 11.3),
    (0.2, 0.2, 0.2, 0.6, 1.7, 2.2, 2.7, 3.8, 5.3, 6.8, 8.5, 9.5, 10.7), (0.2, 0.3, 0.8, 1.3, 2.4, 3.0, 3.5, 4.1, 5.4, 6.7, 8.1, 8.9, 9.9),
    (0.2, 0.8, 1.4, 1.9, 3.1, 3.6, 4.2, 4.8, 5.8, 6.6, 7.2, 7.7, 8.6), (0.5, 1.1, 1.7, 2.2, 3.0, 3.4, 3.7, 4.1, 4.8, 5.5, 5.9, 6.2, 6.7),
    (0.4, 0.7, 1.0, 1.3, 2.0, 2.3, 2.6, 3.0, 3.6, 4.2, 4.6, 4.8, 5.2), (0.2, 0.3, 0.4, 0.5, 0.8, 1.1, 1.4, 1.7, 2.2, 2.8, 3.2, 3.4, 3.7),
    (0.2, 0.2, 0.2, 0.4, 0.6, 0.7, 0.8, 0.9, 1.2, 1.4, 1.7, 2.0, 2.3))
FACE_B = (
    (0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.2, 0.3, 0.3, 0.4), (0.0, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4),
    (0.0, 0.0, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.3, 0.4), (0.0, 0.0, 0.0, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.3, 0.4),
    (0.0, 0.0, 0.0, 0.0, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.4, 0.7), (0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.1, 0.1, 0.1, 0.1, 0.5, 0.7, 1.0),
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.1, 0.3, 0.6, 1.0, 1.5), (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.6, 0.9, 1.3, 1.7, 2.3),
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.6, 1.3, 1.9, 2.3, 3.0), (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.5, 1.2, 1.9, 2.7, 3.6),
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.6, 0.7, 0.8, 1.7, 2.6, 3.4, 4.2, 5.3), (0.1, 0.0, 0.0, 0.0, 0.0, 0.6, 1.3, 1.8, 2.8, 4.5, 5.5, 6.4, 7.7),
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.8, 1.5, 2.1, 3.7, 5.4, 7.1, 8.0, 9.4), (0.0, 0.0, 0.0, 0.0, 0.0, 1.3, 2.1, 2.8, 4.5, 6.3, 7.9, 8.4, 9.9),
    (0.0, 0.0, 0.0, 0.0, 0.0, 1.2, 2.5, 3.2, 4.9, 6.8, 8.5, 9.0, 10.2), (0.0, 0.0, 0.0, 0.0, 0.0, 1.2, 2.4, 3.6, 5.3, 7.3, 9.1, 9.6, 10.5),
    (0.0, 0.0, 0.0, 0.0, 0.0, 1.1, 2.3, 3.5, 5.7, 7.6, 9.6, 10.1, 11.0), (0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 2.2, 3.4, 5.6, 7.5, 9.5, 9.9, 10.7),
    (0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 2.1, 3.4, 5.5, 7.4, 9.3, 9.8, 10.5), (0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 2.1, 3.2, 5.4, 7.3, 9.2, 9.6, 10.3),
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.9, 2.1, 3.2, 5.3, 7.1, 9.0, 9.5, 10.1), (0.0, 0.0, 0.0, 0.0, 0.0, 0.4, 1.5, 2.6, 4.2, 6.0, 7.9, 8.4, 9.1),
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.7, 1.8, 3.2, 4.4, 6.3, 7.0, 7.6), (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.9, 2.3, 2.8, 4.6, 5.3, 6.1),
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.4, 1.3, 1.8, 2.8, 3.5, 4.4), (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.3, 0.7, 1.2, 1.7, 2.2, 3.2),
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.3, 0.6, 1.1, 1.5, 2.0, 2.9), (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.3, 0.6, 0.9, 1.4, 1.7, 2.5),
    (0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.2, 0.5, 0.8, 1.2, 1.4, 2.0), (0.1, 0.1, 0.0, 0.0, 0.0, 0.0, 0.2, 0.3, 0.5, 0.8, 1.1, 1.3, 1.7),
    (0.2, 0.1, 0.0, 0.0, 0.0, 0.0, 0.2, 0.4, 0.9, 1.2, 1.5, 1.7, 2.1))
# The third gallery's (avalanche_gallery_loop), sampled the same way
ROAD_C = (  # about u 0.37, from u 0.335 to 0.405
    (-3.446, -15.554, 0.9931, 0.1171, 0.000),
    (-3.533, -14.558, 0.9984, 0.0568, 0.000),
    (-3.560, -13.558, 1.0000, -0.0017, 0.000),
    (-3.529, -12.559, 0.9982, -0.0598, 0.000),
    (-3.440, -11.563, 0.9929, -0.1192, 0.000),
    (-3.290, -10.575, 0.9827, -0.1854, 0.000),
    (-3.060, -9.602, 0.9605, -0.2782, 0.000),
    (-2.742, -8.655, 0.9372, -0.3488, 0.000),
    (-2.372, -7.725, 0.9243, -0.3816, 0.000),
    (-1.987, -6.802, 0.9252, -0.3796, 0.000),
    (-1.622, -5.872, 0.9365, -0.3506, 0.000),
    (-1.269, -4.936, 0.9305, -0.3663, 0.000),
    (-0.896, -4.008, 0.9285, -0.3714, 0.000),
    (-0.539, -3.074, 0.9431, -0.3325, 0.000),
    (-0.245, -2.119, 0.9691, -0.2465, 0.000),
    (-0.059, -1.137, 0.9930, -0.1182, -0.001),
    (0.001, -0.140, 1.0000, -0.0099, -0.010),
    (-0.023, 0.860, 0.9990, 0.0452, -0.021),
    (-0.078, 1.858, 0.9986, 0.0520, -0.022),
    (-0.115, 2.857, 0.9998, 0.0212, -0.005),
    (-0.139, 3.855, 0.9993, 0.0386, 0.048),
    (-0.186, 4.850, 0.9989, 0.0462, 0.137),
    (-0.219, 5.845, 1.0000, 0.0080, 0.231),
    (-0.190, 6.842, 0.9969, -0.0788, 0.301),
    (-0.056, 7.832, 0.9829, -0.1844, 0.315),
    (0.166, 8.805, 0.9658, -0.2594, 0.263),
    (0.459, 9.756, 0.9450, -0.3272, 0.173),
    (0.818, 10.685, 0.9206, -0.3905, 0.079),
    (1.237, 11.590, 0.8929, -0.4502, 0.010),
    (1.717, 12.466, 0.8607, -0.5091, -0.019),
    (2.251, 13.311, 0.8292, -0.5590, -0.026),
    (2.832, 14.125, 0.7991, -0.6012, -0.021),
    (3.452, 14.910, 0.7693, -0.6389, -0.010))
FACE_C = (
    (0.0, 0.0, 0.0, 0.0, 0.2, 0.9, 1.6, 2.3, 3.6, 5.1, 6.3, 7.0, 8.0),
    (0.0, 0.0, 0.0, 0.0, 0.5, 1.4, 2.1, 2.9, 4.8, 6.3, 7.7, 8.5, 9.7),
    (0.0, 0.0, 0.0, 0.0, 0.4, 1.7, 2.8, 3.5, 5.7, 7.7, 9.1, 10.0, 11.3),
    (0.0, 0.0, 0.0, 0.0, 0.2, 1.5, 2.7, 4.0, 6.1, 8.5, 10.4, 11.4, 12.9),
    (0.0, 0.0, 0.0, 0.0, 0.1, 1.4, 2.7, 4.0, 6.5, 9.0, 11.3, 12.4, 13.9),
    (0.0, 0.0, 0.0, 0.0, 0.1, 1.6, 3.0, 4.3, 6.9, 9.5, 11.9, 12.9, 14.5),
    (0.1, 0.1, 0.1, 0.1, 0.1, 1.2, 2.7, 4.1, 6.8, 9.5, 12.2, 13.4, 15.1),
    (0.1, 0.1, 0.1, 0.1, 0.1, 1.2, 2.5, 3.9, 6.5, 9.1, 11.7, 13.0, 14.6),
    (0.1, 0.1, 0.1, 0.1, 0.1, 1.2, 2.3, 3.6, 6.2, 8.6, 11.2, 12.4, 14.2),
    (0.1, 0.1, 0.1, 0.2, 0.2, 1.1, 2.2, 3.4, 5.9, 8.3, 10.8, 12.0, 13.8),
    (0.2, 0.2, 0.2, 0.2, 0.2, 1.1, 2.2, 3.4, 5.8, 8.1, 10.5, 11.8, 13.6),
    (0.2, 0.2, 0.2, 0.2, 0.2, 1.0, 2.0, 3.2, 5.4, 7.6, 9.9, 11.3, 13.2),
    (0.2, 0.2, 0.2, 0.2, 0.2, 0.9, 1.9, 2.9, 5.1, 7.1, 9.3, 10.6, 9.6),
    (0.2, 0.2, 0.2, 0.2, 0.3, 0.9, 1.9, 2.9, 4.9, 7.0, 9.0, 10.1, 10.3),
    (0.2, 0.2, 0.3, 0.3, 0.3, 1.0, 1.9, 2.9, 4.9, 6.9, 9.0, 10.0, 10.0),
    (0.3, 0.3, 0.3, 0.3, 0.3, 1.0, 1.9, 2.9, 4.9, 7.0, 9.1, 10.5, 12.7),
    (0.3, 0.3, 0.3, 0.3, 0.3, 1.0, 2.0, 2.9, 4.9, 6.9, 9.0, 10.6, 12.7),
    (0.3, 0.3, 0.3, 0.3, 0.3, 1.0, 2.0, 3.0, 5.0, 7.1, 9.1, 10.6, 12.8),
    (0.3, 0.3, 0.3, 0.3, 0.3, 1.1, 2.0, 3.0, 5.1, 7.3, 9.4, 10.5, 9.8),
    (0.3, 0.3, 0.3, 0.3, 0.3, 1.1, 2.1, 3.0, 5.2, 7.6, 9.7, 11.0, 12.0),
    (0.3, 0.3, 0.3, 0.3, 0.3, 1.0, 2.0, 3.0, 5.2, 7.6, 9.8, 11.1, 13.0),
    (0.3, 0.3, 0.3, 0.3, 0.3, 1.1, 2.1, 3.1, 5.2, 7.6, 10.0, 11.3, 13.1),
    (0.3, 0.3, 0.3, 0.3, 0.3, 1.2, 2.2, 3.2, 5.3, 7.6, 9.9, 11.1, 13.0),
    (0.3, 0.3, 0.3, 0.3, 0.3, 1.2, 2.1, 3.1, 5.2, 7.4, 9.6, 10.8, 12.6),
    (0.4, 0.3, 0.3, 0.3, 0.3, 0.9, 1.9, 2.8, 4.6, 6.8, 9.0, 10.2, 11.9),
    (0.3, 0.3, 0.3, 0.3, 0.3, 0.9, 1.5, 2.4, 4.2, 6.0, 8.1, 9.2, 10.9),
    (0.3, 0.3, 0.3, 0.3, 0.3, 0.8, 1.4, 2.1, 3.6, 5.3, 7.0, 8.1, 9.8),
    (0.3, 0.3, 0.3, 0.4, 0.4, 1.0, 1.6, 2.3, 3.4, 4.9, 6.5, 6.7, 8.8),
    (0.2, 0.2, 0.2, 0.4, 0.8, 1.3, 1.8, 2.4, 3.5, 4.4, 6.0, 6.1, 7.7),
    (0.2, 0.2, 0.2, 0.3, 1.0, 1.5, 2.1, 2.6, 3.6, 4.5, 5.4, 6.2, 7.2),
    (0.2, 0.2, 0.2, 0.4, 1.3, 1.9, 2.3, 2.7, 3.6, 4.4, 5.3, 6.1, 7.1),
    (0.2, 0.2, 0.2, 0.5, 1.3, 1.7, 2.2, 2.6, 3.4, 4.2, 5.1, 5.8, 6.8),
    (0.2, 0.2, 0.2, 0.5, 1.1, 1.5, 1.9, 2.4, 3.2, 4.0, 4.9, 5.5, 6.6))
GROUND_Y = -0.517   # Avalanche's plain: where a piece that drapes stands (y = 0 here)
OVER_GAP = 3.0      # spotIssue: anything over the deck clears it by this

def smooth01(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)

def wobble(t, seed, scale=6.0):
    """Smooth noise in about [-1, 1] along a run, `t` in units: three sines at
    incommensurate wavelengths with seeded phases, so no stretch repeats."""
    s = 0.0
    for k, (w, a) in enumerate(((1.0, 0.55), (0.43, 0.3), (0.19, 0.15))):
        ph = 2 * math.pi * frac(math.sin(seed * 12.9898 + k * 78.233) * 43758.5453)
        s += a * math.sin(2 * math.pi * t / (scale * w) + ph)
    return s

def on_road(road, i, l, y):
    """The point `l` across from the road's centreline at sample i (valley-
    ward positive), `y` up, in the piece frame."""
    x, z, nx, nz, _ = road[i]
    return (x + nx * l, y, z + nz * l)

def road_yaw(road, i):
    """box()'s yaw that runs a block's +Z along the road at sample i."""
    return math.atan2(-road[i][3], road[i][2])

def noise2(a, b, seed):
    """Smooth value noise in about [-0.5, 0.5] over a plane: a seeded hash on
    the integer lattice, eased between its corners."""
    ia, ib = math.floor(a), math.floor(b)
    fa, fb = smooth01(a - ia), smooth01(b - ib)
    def h(i, j):
        return jitter(i, j, seed)
    top = h(ia, ib) + (h(ia + 1, ib) - h(ia, ib)) * fa
    bot = h(ia, ib + 1) + (h(ia + 1, ib + 1) - h(ia, ib + 1)) * fa
    return top + (bot - top) * fb

def face_normal(p):
    """The unit normal of a triangle or quad of glTF points, by its winding."""
    if len(p) == 3:
        u = [p[1][k] - p[0][k] for k in range(3)]
        v = [p[2][k] - p[0][k] for k in range(3)]
    else:
        u = [p[2][k] - p[0][k] for k in range(3)]
        v = [p[3][k] - p[1][k] for k in range(3)]
    n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    m = math.sqrt(sum(c * c for c in n)) or 1.0
    return tuple(c / m for c in n)

def sheet(rows, color_of, name, skip=None, facet=None):
    """Quads between consecutive rows of glTF points (rows of one length),
    wound one way over the whole sheet and turned so most of it faces up (an
    overhang's underside then faces down, as it should), each painted
    color_of(i, j, normal): one object per colour. A quad `facet(i, j)` names
    is split into its two triangles, the diagonal alternating, each painted
    by its own normal: rock breaks into facets where snow lies smooth.
    `skip(i, j)` drops a quad no one can see."""
    quads = []
    for i in range(len(rows) - 1):
        a, b = rows[i], rows[i + 1]
        for j in range(len(a) - 1):
            if skip and skip(i, j):
                continue
            quads.append((i, j, (a[j], b[j], b[j + 1], a[j + 1])))
    flip = sum(face_normal(q)[1] for _, _, q in quads) < 0
    polys = []
    for i, j, q in quads:
        if flip:
            q = q[::-1]
        if facet and facet(i, j):
            tris = ((q[0], q[1], q[2]), (q[0], q[2], q[3])) if (i + j) % 2 else ((q[0], q[1], q[3]), (q[1], q[2], q[3]))
            cs = [color_of(i, j, face_normal(t)) for t in tris]
            if not (cs[0] == cs[1] == SNOW):
                polys += [(cs[0], list(tris[0])), (cs[1], list(tris[1]))]
                continue
        polys.append((color_of(i, j, face_normal(q)), list(q)))
    return colored_faces(polys, name)

def swept_block(road, i0, i1, l0, l1, y0, y1, color, sides, ext=0.0, step=2):
    """A block of section l0..l1 across, y0..y1 up, swept along the road from
    sample i0 to i1 (every `step`th sample), `ext` past each end, closed at
    both ends. `sides` names the long faces anyone sees: 'bottom', 'top',
    'valley' (+l), 'hill' (-l)."""
    idx = list(range(i0, i1, step)) + [i1]
    def ring(i, along):
        x, z, nx, nz, _ = road[i]
        tx, tz = -nz, nx
        return [(x + nx * l + tx * along, y, z + nz * l + tz * along)
                for l, y in ((l0, y0), (l1, y0), (l1, y1), (l0, y1))]
    rings = [ring(i, -ext if k == 0 else (ext if k == len(idx) - 1 else 0.0)) for k, i in enumerate(idx)]
    faces_of = {'bottom': (0, 1), 'valley': (1, 2), 'top': (2, 3), 'hill': (3, 0)}
    polys = []
    for side in sides:
        a, b = faces_of[side]
        for r0, r1 in zip(rings[:-1], rings[1:]):
            polys.append((color, [r0[a], r0[b], r1[b], r1[a]]))
    # Wound out of the block as built: with the ring (l0 y0, l1 y0, l1 y1,
    # l0 y1) and the road running on along +T, each long face's normal is
    # its side's, the last ring's cap faces on along the road and the first
    # ring's, reversed, back along it.
    polys += [(color, rings[0][::-1]), (color, rings[-1])]
    return colored_faces(polys, 'swept')[0]

ROCK, SHADE, SNOW = 'grey', 'slate', 0xf3f7fb
SUN = (0.55, 0.75, 0.37)  # rock facing it is ROCK, turned from it SHADE
CONCRETE, TIMBER = 'grey', 0x8a6a46
GALLERY_BEAM = 4.0       # a gallery's beams' underside over the plain
GALLERY_SLAB = (4.32, 4.78)
# the snow on a gallery's roof, from the mountain out: (across, depth over the slab)
ROOF_SNOW = ((-9.2, 1.35), (-7.0, 1.0), (-4.5, 0.75), (-1.5, 0.55), (1.5, 0.45), (4.0, 0.38), (5.55, 0.3))

def roof_snow(l):
    """The roof snow's depth over the slab `l` across (valley-ward positive),
    least of its lumps (gallery_shed jitters each by up to 0.06)."""
    pts = ROOF_SNOW
    if l <= pts[0][0]:
        return pts[0][1] - 0.06
    for (l0, h0), (l1, h1) in zip(pts, pts[1:]):
        if l <= l1:
            return h0 + (h1 - h0) * (l - l0) / (l1 - l0) - 0.06
    return pts[-1][1] - 0.06

def face_ground(face, i, l):
    """The drawn ground's height over the plain `l` hill-ward of the road's
    centreline at sample i, from the piece's FACE table (FACE_L apart)."""
    row = face[i]
    if l <= FACE_L[0]:
        return row[0]
    for k in range(1, len(FACE_L)):
        if l <= FACE_L[k]:
            f = (l - FACE_L[k - 1]) / (FACE_L[k] - FACE_L[k - 1])
            return row[k - 1] + (row[k] - row[k - 1]) * f
    return row[-1]

def cut_face(road, face, i0, i1, s0, s1, seed, ledge, verge, inner):
    """Avalanche's road cut, from sample i0 to i1: where the road runs along
    the mountainside the track's terrain raises beside it (tracks.js
    avalanche `land`, its forms `near` the kerb), the slope's foot blasted
    back for the road. The terrain stands up off the verge in one smooth
    ramp; this is that ramp as broken rock, standing just proud of it so the
    ground never shows through, and going back under it at its top and at
    both ends: no base, no end. From the road out: scree at the foot, a
    lower face, a ledge, an upper face and its crest, from which it dives
    straight back under the land (whatever of it lay along the land past
    the crest stood a hand's breadth over the drawn ground in some places
    and under it in others, and read as loose shards and a dashed line on
    the slope). Ribs stand out of the face and gullies cut back into it; the
    ledge widens to hold snow and narrows to nothing where the two faces run
    into one; every point is pushed about by a smooth noise and every steep
    quad breaks into two facets, so no band runs on and nothing repeats.
    Toward either end it shrinks toward its foot and sinks, keeping its
    pitch: what is left is a smaller face standing out of the slope, never
    a skin pressed flat along it (that read as blades of rock).
    Under a gallery (samples s0..s1) the face is the gallery's back wall: it
    stands nearer the road, in shade, its ledge at the roof (`ledge`), and
    it stops under the roof's snow and, past the roof's back edge, under the
    land, so the roof meets the mountainside with no rock poking through its
    snow (a face just about the snow's height broke through it as a row of
    teeth). The face is rock throughout: snow lies only on the ledge where
    it is wide enough to hold it, in whole quads (snow on the up-turned half
    of a split facet ran along the face as white teeth, and snowy scree at
    the foot climbed the land's rise by a mouth as a white stripe across the
    rock). `verge(i)` is how far out the foot stands at sample i, `inner(i)`
    how far under a roof: further where the road's embankment (a berm)
    reaches out, so no part of the cut lies in it, nearer where the land
    rises off the verge, whose bank would show under the foot. The land is
    the FACE table (the drawn ground, sampled), so the rock is built over
    the plain, not draped: re-sample it whenever the land or the road
    moves."""
    # PROUD: the drawn ground bulges between the table's samples, and at a
    # quarter unit it showed through the face as a white sliver
    PROUD, END = 0.4, 5.0
    CREST, LEDGE = 10, 6      # the profile's rows: the crest; the ledge's quad
    rows, under, ledges = [], [], []
    for i in range(i0, i1 + 1):
        t = float(i - i0)
        g = lambda l: face_ground(face, i, l)
        shed = smooth01((i - (s0 - 3)) / 3.0) * smooth01(((s1 + 3) - i) / 3.0)
        rib = wobble(t, seed + 6, 2.2)                       # ribs out, gullies back, a few units apart
        foot = verge(i) + (inner(i) - verge(i)) * shed + max(-0.3, -0.6 * rib) * (1 - shed)
        wl = max(0.0, 0.6 + 0.8 * wobble(t, seed + 1, 4.0))  # the ledge: none at all in places
        top_l = foot + 2.0 + wl
        # Only where the land stands up beside the road: a cut in flat snow
        # is a wall on the plain.
        taper = smooth01(t / END) * smooth01((i1 - i) / END) * smooth01((g(top_l + 1.0) - 0.8) / 2.0)
        h2 = g(top_l + 1.0) + 0.3 + 0.4 * wobble(t, seed + 2, 5.0)
        h1 = h2 * (0.45 + 0.1 * wobble(t, seed, 7.0)) + 0.3 * rib
        h1 += (ledge - h1) * shed
        h2 = max(h2, h1 + 1.0)
        scree = (0.18 + 0.12 * wobble(t, seed + 5, 3.0)) * (1 - shed)
        g0 = g(foot)
        prof = [(foot - 0.9, g(foot - 0.9) - 0.3), (foot - 0.45, g0 + 0.05 + 0.6 * scree), (foot - 0.15, g0 + 0.2 + scree),
                (foot + 0.15, g0 + 0.2 + 0.3 * (h1 - g0 - 0.2)), (foot + 0.4, g0 + 0.2 + 0.55 * (h1 - g0 - 0.2)),
                (foot + 0.7, g0 + 0.2 + 0.8 * (h1 - g0 - 0.2)), (foot + 0.95, h1), (foot + 0.95 + wl, h1 + 0.15 + 0.1 * wl),
                (foot + 1.3 + wl, h1 + 0.4 * (h2 - h1)), (foot + 1.7 + wl, h1 + 0.75 * (h2 - h1)), (top_l, h2)]
        row, low = [], []
        for j, (d, y) in enumerate(prof):
            if 3 <= j:
                # never so far that a row crosses its neighbour (a fold
                # reads as a white sliver or a spike)
                d += (0.12 if j <= 6 else 0.35) * noise2(t / 1.6, j * 0.9, seed + 11)
                y += 0.4 * noise2(t / 1.4 + 7.3, j * 1.1, seed + 12) * min(1.0, y / 1.5)
            if 2 <= j:
                y = max(y, g(d) + PROUD)                     # proud of the ramp it stands in front of
            d = foot + taper * (d - foot)
            y = g0 + taper * (y - g0) - (1 - taper) * 0.6
            if s0 <= i <= s1:
                y = min(y, GALLERY_SLAB[1] + roof_snow(-d) - 0.25 if d <= -ROOF_SNOW[0][0] else g(d) - 0.2)
            row.append(on_road(road, i, -d, y))
            low.append(y < g(d) - 0.05)
        # past the crest it only goes back under the land
        for dd, dy in ((0.7, -0.3), (1.5, -0.7), (2.4, -1.1)):
            row.append(on_road(road, i, -(d + dd), g(d + dd) + dy))
            low.append(True)
        rows.append(row)
        under.append(low)
        ledges.append(wl * taper)
    in_shed = lambda r: s0 <= r + i0 <= s1
    # Snow lies on a ledge wide and level enough to hold it (a narrow one
    # reads as a sliver), and only along a run of such quads: one or two
    # alone read as slivers hanging on the face.
    held = [min(ledges[r], ledges[r + 1]) > 0.45
            and abs(face_normal((rows[r][LEDGE], rows[r + 1][LEDGE], rows[r + 1][LEDGE + 1], rows[r][LEDGE + 1]))[1]) > 0.8
            for r in range(len(rows) - 1)]
    run = [False] * len(held)
    r = 0
    while r < len(held):
        e = r
        while e < len(held) and held[e]:
            e += 1
        for k in range(r, e):
            run[k] = e - r >= 3
        r = e + 1
    # Rock is dark where a facet turns from the light and pale where it
    # faces it, so the dark runs in whole facets with the rock's shape
    # (picked at random per quad it read as tiles); the face under a roof
    # is in its shade but for the facets turned to the mouth a racer comes
    # in by, which catch the daylight from it.
    def color(r, j, n):
        if j == LEDGE and n[1] > 0.8 and run[r]:
            return SNOW
        if j >= CREST:
            return ROCK
        if in_shed(r) and j <= 6:
            return ROCK if n[2] < -0.3 else SHADE
        return ROCK if n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2] > 0.25 else SHADE
    # In chunks a part each (a 40 u run in one part is never culled).
    CH = 10
    for a in range(0, len(rows) - 1, CH):
        # a quad wholly under the land (the toe, the tapered ends) is no one's
        hidden = lambda r, j, a=a: all(under[r + a + di][j + dj] for di in (0, 1) for dj in (0, 1))
        for o in sheet(rows[a:a + CH + 1], lambda r, j, n, a=a: color(r + a, j, n), 'cut', skip=hidden,
                       facet=lambda r, j: 2 <= j < CREST and j != LEDGE):
            if o['swatch'] == 'white':
                snowy(o, 0.45)
    return rows

def cut_ice(rows, i0, seeps, firs, seed):
    """Dress a cut_face as built (its `rows`, the first at sample i0): at
    each sample in `seeps`, where water seeps out of the rock and froze, ICE
    AS IT HANGS: a curtain of icicles from the crest's lip down the upper
    face, widest at the lip and longest in its middle, no two the same
    length; the ledge under it glazed; a second, narrower curtain off the
    ledge's own lip, set a little to one side; and at the foot a boss of
    three fused lumps. Nothing runs down the face as a band: a strip of ice
    from crest to foot, and columns laid on it, both read from the road as
    chutes fixed to the rock. At each sample in `firs` a snow-laden spruce
    standing back from the cut's top edge, held up from the plain inside
    the land. Nothing of the cut moves."""
    def lerp(a, b, f):
        return tuple(a[k] + (b[k] - a[k]) * f for k in range(3))
    for n_, i in enumerate(seeps):
        r = i - i0
        a, b = rows[r], rows[r + 1]
        out = (a[0][0] - a[10][0], 0.0, a[0][2] - a[10][2])      # from the crest toward the road
        m = math.hypot(out[0], out[2]) or 1.0
        out = (out[0] / m, 0.0, out[2] / m)
        def lip(j, f, proud):
            q = lerp(a[j], b[j], f)
            return (q[0] + out[0] * proud, q[1], q[2] + out[2] * proud)
        def curtain(j, f0, f1, n, reach, tag):
            """`n` icicles hanging from row j's lip between f0 and f1, the
            middle ones `reach` long, each bedded in the lip above it."""
            for k in range(n):
                f = f0 + (f1 - f0) * (k + 0.5 + 0.35 * jitter(k, tag, seed + n_)) / n
                mid = 1.0 - abs(2.0 * (k + 0.5) / n - 1.0)                 # 0 at the edges, 1 in the middle
                L = reach * (0.35 + 0.65 * mid) * (0.75 + 0.5 * (0.5 + jitter(k, tag + 1, seed + n_)))
                rad = 0.17 + 0.16 * mid + 0.05 * jitter(k, tag + 2, seed + n_)
                top = lip(j, f, 0.12 + 0.1 * (0.5 + jitter(k, tag + 3, seed + n_)))
                o = rod((top[0], top[1] + 0.12, top[2]), (top[0] + out[0] * 0.05, top[1] - L, top[2] + out[2] * 0.05),
                        rad, SNOW if k % 3 != 1 else 'sky', r2=0.025, segs=5)
                snowy(o, 0.4 if k % 3 != 1 else 0.3)
            # the ice the lip itself wears: a low cap along it, the icicles' root
            c0, c1 = lip(j, f0, 0.1), lip(j, f1, 0.1)
            mid_ = lip(j, (f0 + f1) / 2, 0.14)
            snowy(sphere(0.3, (mid_[0], mid_[1] + 0.02, mid_[2]), SNOW, subdiv=1,
                         scale=(math.hypot(c1[0] - c0[0], c1[2] - c0[2]) / 0.6 + 0.4, 0.3, 0.6),
                         yaw=math.atan2(c1[0] - c0[0], c1[2] - c0[2]) + math.pi / 2), 0.35)
        s0 = 0.1 + 0.08 * jitter(n_, 1, seed)
        reach = max(1.5, min(3.4, 0.85 * (a[10][1] - a[7][1])))
        curtain(10, s0 - 0.25, s0 + 1.1, 9, reach, 3)
        side = 0.18 if jitter(n_, 9, seed) > 0 else -0.05
        curtain(6, s0 + side - 0.1, s0 + side + 0.75, 6, max(1.2, min(2.6, 0.8 * (a[6][1] - a[2][1]))), 13)
        # the boss at the foot, under the lower curtain
        foot = lip(1, s0 + side + 0.28, 0.3)
        for k, (dx, dz, rr) in enumerate(((0.0, 0.0, 0.5), (0.45, 0.25, 0.36), (-0.4, 0.2, 0.3))):
            t = (-out[2], out[0])                                  # along the face
            snowy(sphere(rr, (foot[0] + t[0] * dx + out[0] * dz, foot[1] - 0.12, foot[2] + t[1] * dx + out[2] * dz),
                         SNOW if k != 1 else 'sky', subdiv=1, scale=(1.2, 0.55, 1.1), yaw=jitter(n_, 7 + k, seed) * 3.0),
                  0.4 if k != 1 else 0.3)
    for n_, i in enumerate(firs):
        r = i - i0
        c, back = rows[r][10], rows[r][12]
        k = 1.0 + 0.35 * (0.5 + jitter(n_, 4, seed))
        x, z = back[0], back[2]
        g = back[1] + 0.7
        spruce((x, g - 0.35 * k, z), k)
        box((0.24 * k, g, 0.24 * k), (x, g / 2 - 0.35 * k, z), 0x7a5a3a)['chamfer'] = 0

def gallery_shed(road, s0, s1, seed):
    """An avalanche gallery over the road from sample s0 to s1, at its real
    size beside a car, built into the cut: open on the valley side, square
    concrete columns carrying a lintel, timber beams across under a concrete
    roof, the roof's far edge on a concrete seat let into the rock, so the
    mountain itself is the gallery's back wall. The slope's snow lies on the
    roof, deepest against the mountain, and hangs over the valley edge in a
    cornice with icicles and over each mouth in a lip. Every part over the
    road clears the highest deck under it by OVER_GAP; the camera rides lower
    still."""
    BEAM, (SLAB0, SLAB1) = GALLERY_BEAM, GALLERY_SLAB
    for i in range(s0, s1 + 1):
        if BEAM + GROUND_Y - road[i][4] < OVER_GAP + 0.15:
            raise SystemExit('gallery: the beams clear the deck at sample %d by %.2f'
                             % (i, BEAM + GROUND_Y - road[i][4]))
    COL, SEAT = 4.75, -6.0
    # the roof slab, from the rock out past the valley side; its fascia over
    # each mouth
    snowy(swept_block(road, s0, s1, -8.6, 5.6, SLAB0, SLAB1, CONCRETE, ('bottom', 'valley'), ext=0.3), 0.6)
    # the seat the roof's far edge rests on, let into the rock
    snowy(swept_block(road, s0, s1, -7.4, SEAT + 0.3, BEAM - 0.45, SLAB0, CONCRETE, ('bottom', 'valley'), ext=0.3), 0.6)
    # the lintel along the columns' heads
    snowy(swept_block(road, s0, s1, COL - 0.35, COL + 0.35, BEAM - 0.05, SLAB0, CONCRETE,
                      ('bottom', 'valley', 'hill'), ext=0.3), 0.6)
    cols = list(range(s0, s1 + 1, 4))
    if s1 - cols[-1] > 1:
        cols.append(s1)
    for i in cols:
        x, _, z = on_road(road, i, COL, 0)
        snowy(box((0.6, BEAM + 0.45, 0.6), (x, (BEAM - 0.45) / 2, z), CONCRETE, yaw=road_yaw(road, i)), 0.6)
    for i in range(s0 + 1, s1, 2):
        x, _, z = on_road(road, i, (COL + SEAT) / 2, 0)
        box((COL - SEAT, 0.32, 0.36), (x, BEAM + 0.16, z), TIMBER, yaw=road_yaw(road, i))
    # the snow on the roof: deepest against the mountain, lumpy, over the
    # valley edge in a cornice; a row past each end hangs over the mouth
    prof_l = tuple(l for l, _ in ROOF_SNOW) + (5.95, 6.1, 5.95)
    rows = []
    idx = [s0 - 1] + list(range(s0, s1 + 1, 2)) + ([s1] if (s1 - s0) % 2 else []) + [s1 + 1]
    for k, i in enumerate(idx):
        end = k == 0 or k == len(idx) - 1
        x, z, nx, nz, _ = road[min(max(i, s0), s1)]
        tx, tz = -nz, nx
        along = (-0.6 if k == 0 else 0.6) if end else 0.0
        over = 1.0 + 0.25 * wobble(i, seed + 7, 3.0)
        row = []
        for j, l in enumerate(prof_l):
            if j < 7:
                y = SLAB1 + ROOF_SNOW[j][1] + 0.12 * jitter(i, j, seed)
            else:
                y = SLAB1 + (0.28 * over, 0.02, -0.32 * over)[j - 7]
            if end:
                y = min(y, SLAB1 + 0.25) - 0.3
            lw = l + (0.25 * over if j >= 7 else 0.0)
            row.append((x + nx * lw + tx * along, y, z + nz * lw + tz * along))
        rows.append(row)
    for o in sheet(rows, lambda i, j, n: SNOW, 'roof_snow'):
        snowy(o, 0.4)
    # icicles off the cornice's lip, on the snow's own rows
    with plain_parts():
        for i in range(s0 + 2, s1 - 1, 4):
            over = 1.0 + 0.25 * wobble(i, seed + 7, 3.0)
            ln = 0.35 + 0.35 * (jitter(i, 3, seed) + 0.5)
            x, _, z = on_road(road, i, 5.9 + 0.25 * over, 0)
            cyl(0.02, ln, (x, SLAB1 - 0.32 * over + 0.06 - ln, z), 'sky', r2=0.11, segs=3, stem=True)

def stone(x, z, s, yaw, seed, squat=1.0, rock=(ROCK, SHADE), top=None, y=0.0):
    """A broken rock `s` across lying on the plain at (x, z): a lump of
    fifteen facets, no two alike, wider than tall and bedded a little in the
    ground, rock where a facet turns to the side and snow where it faces the
    sky. A box with a slab of snow on it read as a crate. `squat` scales its
    height before the snow is laid; `rock` is its (sunlit, turned) swatches;
    `top` what lies on what faces the sky (snow unless named: bare rock on
    the beach); `y` sinks or lifts it."""
    N = 5
    c, sn = math.cos(yaw), math.sin(yaw)
    y0 = y
    def at(a, r, y):
        lx, lz = r * math.cos(a), 0.8 * r * math.sin(a)
        return (x + lx * c + lz * sn, y0 + squat * y, z - lx * sn + lz * c)
    low = [at(2 * math.pi * k / N, s * (0.55 + 0.2 * jitter(k, 1, seed)), -0.12 * s) for k in range(N)]
    high = [at(2 * math.pi * (k + 0.5) / N + 0.3 * jitter(k, 2, seed), s * (0.38 + 0.14 * jitter(k, 3, seed)),
               s * (0.42 + 0.12 * jitter(k, 4, seed))) for k in range(N)]
    apex = at(0.7 * seed, 0.12 * s, s * (0.62 + 0.08 * jitter(0, 5, seed)))
    tris = []
    for k in range(N):
        a, b, h0, h1 = low[k], low[(k + 1) % N], high[k], high[(k + 1) % N]
        tris += [(a, b, h0), (b, h1, h0), (h0, h1, apex)]
    polys = []
    for t in tris:
        n = face_normal(t)
        out = [sum(p[k] for p in t) / 3 - o for k, o in enumerate((x, y0 + 0.25 * s * squat, z))]
        if n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0:   # wound out of the lump
            t, n = t[::-1], tuple(-v for v in n)
        if n[1] > 0.75:
            col = SNOW if top is None else top
        else:
            col = rock[0] if n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2] > 0.25 else rock[1]
        polys.append((col, list(t)))
    for o in colored_faces(polys, 'stone'):
        if o['swatch'] == 'white':
            snowy(o, 0.45)

def fallen_rock(road, boulders):
    """Rocks come down off the face onto the verge at its foot: (sample, how
    far out from the road's centreline, size). DRAPED: each lies on the land
    as drawn there, the mountainside's foot."""
    def build():
        with plain_parts():
            for k, (i, l, s) in enumerate(boulders):
                x, _, z = on_road(road, i, -l, 0.0)
                stone(x, z, s * 1.5, road_yaw(road, i) + 1.3 * k, 3.1 * k + i)
    draped('scree', build)

def crag(spine, peaks, seed, sink=2.5, top=None, rock=('lavender', ROCK), snow=0.68):
    """A crest of the mountain's own rock breaking out of its snow, along
    `spine` ((x, z) points in the piece frame): sections across it about 2 u
    apart, each a foot either side sunk `sink` under the snow, a shoulder and
    the crest, the crest's height read off `peaks` ((share of the spine,
    height) pairs) and jagged by a noise, so it rises in teeth, not a wall.
    Toward either end it sinks under the snow it stands in: no base and no
    end. Every quad breaks into two facets, rock where the quad turns to the
    side, snow where it faces the sky. Each foot is a snow apron under 35
    degrees out to where it sinks, so the rock grows out of the mountain's
    snow: a steep rock flank down to the snow read as a crown on the dome,
    on a hard dark line. `rock` is its (sunlit, turned) swatches, and snow
    lies on a facet whose normal's rise is over `snow`. DRAPED, so y = 0 is
    the snow as drawn: stand it on a crest, where the land under it lies near
    level, or the drape shears it."""
    pts = [spine[0]]
    for a, b in zip(spine, spine[1:]):
        n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / 2.0 + 0.5))
        pts += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(1, n + 1)]
    run = [0.0]
    for a, b in zip(pts, pts[1:]):
        run.append(run[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    L = run[-1]
    def height(f):
        for (f0, h0), (f1, h1) in zip(peaks, peaks[1:]):
            if f <= f1:
                return h0 + (h1 - h0) * (f - f0) / max(1e-6, f1 - f0)
        return peaks[-1][1]
    rows = []
    for i, (x, z) in enumerate(pts):
        a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
        tx, tz = b[0] - a[0], b[1] - a[1]
        m = math.hypot(tx, tz) or 1.0
        nx, nz = tz / m, -tx / m
        s = run[i]
        end = smooth01(min(s, L - s) / 4.0)
        # summits: the crest rises and falls by a third of its height over
        # some ten units (a tooth every two read as a picket)
        hc = height(s / L) * (0.82 + 0.3 * wobble(s, seed, 9.0))
        hc = end * hc - (1 - end) * sink
        # under four units high it narrows with its height, so a low run
        # (a rib's foot) stays a steep spine of rock sinking into the snow,
        # not a broad lump whose facets flip between snow and rock
        w = 0.85 * max(hc, 0.0) + 2.2 * min(1.0, max(hc, 0.3) / 4.0)
        off = 0.2 * w * wobble(s, seed + 3, 11.0)           # the crest wanders off the spine
        j = lambda k, a: a * jitter(i, k, seed)
        skirt = 0.45 * w + sink                              # the apron's run
        lo, hi = -w * (0.72 + j(3, 0.1)) + off, w * (0.7 + j(10, 0.1)) + off
        prof = [(lo - skirt * (1.0 + j(2, 0.3)), -sink),
                (lo, hc * (0.2 + j(4, 0.1))),
                (-w * (0.38 + j(5, 0.1)) + off, hc * (0.62 + j(6, 0.1))),
                (off + j(7, 0.12) * w, hc),
                (w * (0.34 + j(8, 0.1)) + off, hc * (0.66 + j(9, 0.1))),
                (hi, hc * (0.24 + j(11, 0.1))),
                (hi + skirt * (1.0 + j(12, 0.3)), -sink)]
        rows.append([(x + nx * d, y, z + nz * d) for d, y in prof])
    # The rock a shade lighter than a cut face's: turned from the sun, slate
    # under the bake's shade read as black teeth against the snow. One colour
    # a quad, by the quad's normal: its two facets painted apart read as a
    # checkerboard down a rib.
    qn = {(i, j): face_normal((a[j], b[j], b[j + 1], a[j + 1]))
          for i, (a, b) in enumerate(zip(rows, rows[1:])) for j in range(len(a) - 1)}
    up = 1.0 if sum(q[1] for q in qn.values()) >= 0 else -1.0
    def color(i, j, n):
        n = tuple(up * c for c in qn[i, j])
        if n[1] > snow:
            return SNOW if top is None else top
        return rock[0] if n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2] > 0.25 else rock[1]
    for o in sheet(rows, color, 'crag', facet=lambda i, j: True):
        if o['swatch'] == 'white':
            snowy(o, 0.45)

@piece(1.0)
def snow_sapling():
    # Avalanche's verge scatter (theme.cc avalanchePass): a young spruce
    # growing back by the road, snow-laden, its real size beside a car.
    spruce((0.0, -0.1, 0.0), 0.85)

@piece(1.0)
def snow_log():
    # ...and, rarely, a trunk a slide snapped and the plough pushed to the
    # verge, snow lying along its top.
    snapped_trunk(-1.0, 0.0, 0.0, 1.0, 0.0)
    snowy(box((1.8, 0.08, 0.16), (0.0, 0.17, 0.0), 0xf3f7fb), 0.45)

@piece(1.0)
def snow_boulder():
    # The snow tracks' scatter rock (theme.cc snowProps) in place of the kit's
    # rocks, which read as stacked crates: three faceted lumps bedded in the
    # snow, snow on what faces the sky, some three units across at scale 1
    # and a little squat (a lump as tall as the galleries' read as a dark
    # cone, a flat one as a brick), all in the crags' lighter rock with the
    # bake's light alone shading its turned side: slate under that shade read
    # as a charcoal brick on a crest, and from below a crest its snow never
    # shows. One part, so a run of them is one draw, not one a stone.
    for (x, z, s, yaw, seed) in ((0.0, 0.0, 2.0, 0.3, 1.0), (0.95, 0.85, 1.25, 1.7, 2.0), (-0.8, 0.95, 0.9, 2.9, 3.0)):
        stone(x, z, s, yaw, seed, squat=0.8, rock=('lavender', 'lavender'))
    join_still('boulder')

def alp(cx, cz, h, r, seed, stretch=1.0, turn=0.0, lean=(0.0, 0.0), sun=(0.0, 1.0, 0.0), sink=2.0):
    """One alpine peak of a range running along Z, standing `h` over the land
    it drapes on, its foot `r` across (cx, cz) and `stretch` times that along
    the range. Four aretes fall from the summit: two along the range, which
    keep their height long so they meet the next peak's in a saddle well up
    its flank, and a spur toward the road (-X) and one behind, falling
    straight. Between them a face falls steep from the summit and levels out
    low (a cirque), so rock shows where a face is steep and snow lies on the
    aretes' backs and the lower slopes. The summit stands `lean` (a share of
    r) off the foot's centre; the foot sinks `sink` under the snow. Every
    quad breaks into two facets painted alike, by the quad's normal (paint_of
    below); the foot's are snow whatever their slope, so the peak stands in
    the land's snow, not on a dark rim. DRAPED, so y = 0 is the land as
    drawn."""
    NS = 16
    T = (0.0, 0.1, 0.2, 0.32, 0.46, 0.62, 0.78, 0.9, 1.0)
    sx, sz = cx + lean[0] * r, cz + lean[1] * r
    spokes = []
    for j in range(NS):
        k = j % 4
        rho = 1.0 if k == 0 else (0.0 if k == 2 else 0.45)       # arete, flank, face
        a = turn + 2 * math.pi * (j + 0.2 * jitter(j, 1, seed)) / NS
        along = math.sin(a) ** 2
        # the profile's exponent: an arete along the range falls straight and
        # long, a spur a little steeper, a face steep from the summit and
        # levelling out low
        p = rho * (1.15 - 0.2 * along) + (1 - rho) * 1.9
        spokes.append((a, rho, p, 1.0 + (stretch - 1.0) * along))
    rows = []
    for i, t in enumerate(T):
        row = []
        for j, (a, rho, p, ell) in enumerate(spokes):
            if i == 0:
                row.append((sx, h, sz))
                continue
            if i == len(T) - 1:
                y, tt = -sink, 1.12
            else:
                y, tt = h * (1 - t) ** p * (1 + 0.14 * jitter(i, j + 7, seed)), t
                if rho == 1.0:                                     # a tooth on each arete
                    y += h * 0.06 * math.sin(math.pi * min(1.0, t / 0.5)) * (0.5 + jitter(i, j + 3, seed))
            rr = r * ell * tt * (0.82 + 0.18 * rho + 0.12 * jitter(i, j + 13, seed))
            ox, oz = sx + (cx - sx) * min(t, 1.0), sz + (cz - sz) * min(t, 1.0)
            row.append((ox + rr * math.cos(a), y, oz + rr * math.sin(a)))
        row.append(row[0])
        rows.append(row)
    sh = math.hypot(sun[0], sun[2]) or 1.0
    def paint_of(n, foot):
        # Snow where it can lie and on the faces the sun is on; rock where a
        # face turns from it (the dark side every peak shows, which is what
        # makes it read as a solid in a flat-lit world) or is too steep to hold
        # snow at all. A cap of rock over snowy shoulders read as a crown.
        if n[1] < 0:
            n = tuple(-c for c in n)
        toward = (n[0] * sun[0] + n[2] * sun[2]) / ((math.hypot(n[0], n[2]) or 1.0) * sh)
        if foot or n[1] > 0.84:
            return SNOW
        if toward < 0.0:
            return SHADE
        if toward < 0.4 or n[1] < 0.55:
            return ROCK
        return SNOW
    # One colour a quad, by the quad's normal: its two facets painted apart
    # read as a scatter of dark shards over the face (crag()'s checkerboard).
    polys = []
    for i in range(len(rows) - 1):
        a, b = rows[i], rows[i + 1]
        for j in range(NS):
            if i == 0:
                tris = [(a[j], b[j], b[j + 1])]
                col = paint_of(face_normal(tris[0]), False)
            else:
                col = paint_of(face_normal((a[j], b[j], b[j + 1], a[j + 1])), i >= len(rows) - 2)
                if (i + j) % 2:
                    tris = [(a[j], b[j], b[j + 1]), (a[j], b[j + 1], a[j + 1])]
                else:
                    tris = [(a[j], b[j], a[j + 1]), (b[j], b[j + 1], a[j + 1])]
            for t in tris:
                if face_normal(t)[1] < 0:
                    t = t[::-1]
                polys.append((col, list(t)))
    for o in colored_faces(polys, 'alp'):
        snowy(o, 0.12 if o['swatch'] == 'white' else 0.35)

@piece(1.0)
def glacier_peaks():
    # Glacier: the range over the top straight's outside, set back 45 to 90
    # units from it, which the opening drives toward and the straight runs
    # along: six peaks whose aretes along the range meet in saddles, zigzag
    # in depth so they overlap from the road, the foothills in front of them
    # (tracks.js glacier `land`). Each summit stands a little under the top of
    # the chase camera's picture where it comes nearest ahead, so a peak reads
    # whole; the camera banking through the bend under the range still clips
    # a flank at the picture's top-left corner. Placed at u 0.185, lat -60:
    # +X north, away from the road, +Z east along the straight; one part a
    # peak, so each culls and takes its far form alone.
    sun = (-0.122, 0.979, 0.163)            # the renderer's kToSun in this frame
    for k, (cx, cz, h, r, stretch, seed, turn, lean) in enumerate((
            (-20.0, -109.0, 14.5, 15.0, 1.8, 13.0, 0.25, (0.0, 0.1)),     # far west
            (18.0, -81.0, 20.0, 19.0, 1.8, 3.0, 0.1, (0.08, -0.08)),      # west
            (10.0, -44.0, 14.5, 16.0, 1.9, 5.0, -0.12, (-0.1, 0.05)),     # the middle one, nearest
            (30.0, -4.0, 20.0, 19.0, 1.8, 7.0, 0.15, (0.05, 0.1)),        # furthest back
            (26.0, 43.0, 21.5, 18.0, 1.8, 9.0, -0.08, (-0.08, -0.06)),
            (0.0, 81.0, 16.5, 16.0, 1.9, 11.0, 0.2, (0.1, 0.0)))):        # east, over the straight's end
        # Each with a lesser summit on its shoulder along the range, to one
        # side or the other, so its skyline breaks in two teeth, not one cone.
        side = 1.0 if k % 2 else -1.0
        def build():
            alp(cx, cz, h, r, seed, stretch, turn, lean, sun)
            alp(cx + 0.15 * r, cz + side * 0.5 * r * stretch, 0.66 * h, 0.6 * r, seed + 50.0, stretch, turn + 0.5,
                (0.0, 0.0), sun)
        draped('peak%d' % k, build)

def peak_range(sun, peaks):
    """A range of alp() peaks, one part each, every one with a lesser summit
    on its shoulder along the range, to one side or the other, so its skyline
    breaks in two teeth, not one cone (Glacier's range, glacier_peaks). Each
    peak is (cx, cz, h, r, stretch, seed, turn, lean) in the piece frame, the
    range running along Z; `sun` is the renderer's kToSun in that frame."""
    for k, (cx, cz, h, r, stretch, seed, turn, lean) in enumerate(peaks):
        side = 1.0 if k % 2 else -1.0
        def build():
            alp(cx, cz, h, r, seed, stretch, turn, lean, sun)
            alp(cx + 0.15 * r, cz + side * 0.5 * r * stretch, 0.62 * h, 0.6 * r, seed + 50.0, stretch, turn + 0.5,
                (0.0, 0.0), sun)
        draped('peak%d' % k, build)

@piece(1.0)
def glacier_peaks_south():
    # Glacier: a second stretch of the range, closing the valley's south side
    # past the terminal moraine (tracks.js glacier `land`, its swells under
    # these summits), which the east leg drives at down its whole length and
    # the bottom loop turns under. Placed at u 0.661, lat -70: +X south, away
    # from the road, the range along Z (east to west).
    peak_range((0.133, 0.979, -0.154), (
        (-15.1, -54.2, 13.0, 14.0, 1.7, 71.0, 0.2, (0.05, 0.1)),
        (-5.8, -16.4, 17.0, 17.0, 1.8, 73.0, -0.1, (-0.05, 0.05)),
        (-16.5, 20.9, 14.5, 15.0, 1.8, 75.0, 0.15, (0.08, -0.05)),
        (-30.8, 51.9, 11.0, 13.0, 1.6, 77.0, 0.3, (0.0, 0.08))))

@piece(1.0)
def glacier_peaks_east():
    # Glacier: rock-faced summits on the massif behind the foothills that
    # rise off the east leg's outside verge, so the leg runs under a range on
    # its left as the top straight does. Placed at u 0.45, lat -66: +X east,
    # away from the road, the range along Z (north to south).
    peak_range((0.140, 0.979, 0.148), (
        (11.4, -46.0, 10.0, 12.0, 1.6, 81.0, 0.25, (0.05, 0.05)),
        (-0.4, 10.8, 11.0, 13.0, 1.7, 83.0, -0.15, (-0.05, 0.08)),
        (-14.5, 63.2, 9.0, 11.0, 1.6, 85.0, 0.1, (0.06, 0.0))))

@piece(1.0)
def avalanche_peaks_east():
    # Avalanche: the high peaks the slides start from, east of the forested
    # mountainside outside the top loop, on the backs of its ridges and the
    # massif behind them, so the stands are the foothills and the range rises
    # over them: dead ahead from the crossing and through the S-bend. Placed
    # at u 0.276, lat 48.12, yaw -167.06, the frame the world's (+X east,
    # away from the road; +Z south, the range along it). Painted to a sun in
    # the south-south-west, not the renderer's (south-east): the racer sees
    # the range from the west, where every face is turned from the real sun
    # and the range read as dark rock with no snow on it; this way each peak
    # shows the road Glacier's snow on one side of its arete and rock on the
    # other. Each summit stands over land of its own height (+14.5 on the
    # north massif's flank down to +1.5), set so it stands just under the
    # top of the chase picture where it comes nearest ahead.
    peak_range((-0.08, 0.979, 0.2), (
        (-0.1, -46.6, 13.0, 15.0, 1.7, 91.0, 0.2, (0.05, 0.1)),
        (7.9, -12.6, 17.0, 17.0, 1.8, 93.0, -0.1, (-0.05, 0.05)),
        (1.9, 23.4, 16.0, 16.0, 1.8, 95.0, 0.15, (0.08, -0.05)),
        (-10.1, 50.4, 14.0, 14.0, 1.7, 97.0, 0.3, (0.0, 0.08))))

@piece(1.0)
def powder_peaks():
    # Powder: the range over the start straight's outside, the resort's back
    # wall, which the long run north drives at and the start straight runs
    # along: four peaks, each on a summit of the massif behind the foothills
    # at the kerb (tracks.js powder `land`). Placed at u 0.03, lat -60, yaw
    # 0: +X north, away from the road, +Z east along the start straight (the
    # frame Glacier's range has, so the same sun).
    peak_range((-0.122, 0.979, 0.163), (
        (-15.0, -72.0, 9.0, 12.0, 1.6, 29.0, 0.3, (0.05, 0.1)),       # west, over the ski mountain's shoulder
        (10.0, -32.0, 12.0, 14.0, 1.7, 21.0, 0.15, (0.08, -0.06)),
        (22.0, 13.0, 14.0, 16.0, 1.8, 23.0, -0.1, (-0.05, 0.08)),     # the highest, the horn
        (-5.0, 55.0, 12.0, 14.0, 1.7, 27.0, 0.2, (0.1, 0.0))))        # east, over the bend

@piece(1.0)
def flurry_peaks_ne():
    # Flurry: the peaks on the massif past the east loop's outside, behind
    # the foothills at its kerb (tracks.js flurry `land`), the range the
    # crossing's descent and the loop drive at. Placed at u 0.64, lat 45:
    # +X toward the loop, the range along Z, north-west to south-east.
    peak_range((-0.021, 0.979, -0.202), (
        (24.0, -51.4, 11.0, 13.0, 1.6, 31.0, 0.2, (0.05, 0.1)),
        (11.6, -5.9, 13.0, 15.0, 1.7, 33.0, -0.1, (-0.05, 0.05)),
        (11.6, 48.6, 12.0, 14.0, 1.7, 35.0, 0.15, (0.08, 0.0))))

@piece(1.0)
def flurry_peaks_sw():
    # Flurry: the peaks on the massif past the west loop's outside, behind
    # the foothills at its kerb, south of the ski jump's hill. Placed at
    # u 0.12, lat 45: +X toward the loop, the range along Z.
    peak_range((0.022, 0.979, 0.202), (
        (-1.3, -3.6, 13.0, 15.0, 1.7, 41.0, 0.1, (0.05, -0.05)),
        (13.3, 48.5, 11.0, 13.0, 1.6, 45.0, 0.25, (0.05, 0.0))))

@piece(1.0)
def flurry_peaks_nw():
    # Flurry: the peaks on the long snow ridge closing the valley's north-west
    # side (tracks.js flurry `land`, u 0.39 lat -70), which the run north to
    # the lake and the crossing look over. Placed on the ridge's spine, at
    # u 0.39, lat -70: +X away from the road, the ridge along Z.
    peak_range((-0.188, 0.979, 0.079), (
        (4.0, -28.0, 11.0, 13.0, 1.6, 51.0, 0.15, (0.05, 0.05)),
        (2.0, -1.0, 8.0, 10.0, 1.5, 53.0, -0.2, (0.0, 0.1)),
        (4.0, 24.0, 12.0, 14.0, 1.7, 55.0, 0.1, (-0.05, 0.0))))

@piece(1.0)
def flurry_peaks_se():
    # Flurry: the peaks on the ridge closing the south-east side (u 0.92
    # lat -68), over the run in to the start. Placed on its spine: +X away
    # from the road, the ridge along Z.
    peak_range((0.190, 0.979, -0.072), (
        (4.0, -15.0, 11.0, 13.0, 1.6, 61.0, 0.2, (0.05, 0.0)),
        (3.0, 20.0, 9.0, 11.0, 1.5, 63.0, -0.1, (0.0, -0.08))))

@piece(1.0)
def avalanche_crags():
    # Avalanche: the southern massif over the long gallery's straight
    # (tracks.js avalanche `land`) breaks out of its snow along its crest,
    # running on toward the lower peak, a jagged skyline the racer drives at
    # off the slide's foot. Placed on the massif's spine (u 0.8349, lat
    # 52.1, yaw 3), +X toward the road, +Z along it; the lower peak's summit
    # is at (-5.5, 44).
    def build():
        crag([(2.0, -20.0), (-1.0, -8.0), (0.0, 4.0), (-2.0, 16.0), (-4.0, 28.0), (-5.0, 38.0)],
             ((0.0, 5.0), (0.2, 11.0), (0.4, 14.0), (0.6, 9.0), (0.8, 10.0), (1.0, 5.0)), seed=33.0)
    draped('crags', build)

@piece(1.0)
def avalanche_crags_west():
    # Avalanche: the western massif's summit (tracks.js avalanche `land`)
    # breaks out of its snow, the crest the run to the short gallery looks
    # at. Placed on its summit (u 0.7091, lat 67.4), +X toward the road, +Z
    # along it.
    def build():
        crag([(2.0, -16.0), (0.0, -4.0), (-1.0, 4.0), (-3.0, 13.0)],
             ((0.0, 4.0), (0.4, 11.0), (0.7, 8.0), (1.0, 4.0)), seed=41.0)
    draped('crags', build)

# Rock ribs down the cirque faces' fall lines (scratch/ribs.mjs, traced on the
# drawn ground from just under each crest to h 8), in the cirque's frame
# (world-aligned, its origin at u 0.776, lat 5.5); and the ground under the
# slide's cornice, a station every 1.5 u along it and across it at -3, -1, 0,
# 0.4, 1.4, 1.8, 2.2, 4, 5.5 toward the road. Re-trace them if the land under
# them moves. Each face is a piece of its own, placed world-aligned at its
# RIB_AT (in the cirque's frame): one piece over the faces kept the whole
# last loop's verge clear of scatter, its footprint the box round all of
# them. Ribs that read wrong are gone: one alone right of the slide's chute
# read as an egg, one seen end-on from the S-bend as a dagger, one along the
# west face's skyline as a plank; the south face's last two then read not at
# all, and went with them.
RIB_AT = {'w': (-31.57, -49.53), 'slide': (-35.97, 14.05)}
RIBS = {
    'w': (((-33.5, -53.5), (-31.7, -55.0), (-29.8, -56.6), (-28.0, -58.2), (-26.2, -59.7), (-24.3, -61.2), (-22.0, -61.8), (-19.6, -62.3), (-17.2, -62.7), (-14.9, -63.0)),
        ((-42.5, -41.5), (-41.7, -39.3), (-40.8, -37.1), (-40.7, -34.7), (-40.8, -32.3), (-40.8, -29.9), (-40.6, -27.5), (-40.1, -25.1)),
        ((-41.0, -56.5), (-40.7, -58.9), (-40.4, -61.3), (-40.1, -63.7), (-39.6, -66.0), (-38.5, -68.1))),
    'slide': (((-42.5, 17.0), (-40.1, 16.8), (-37.8, 16.7), (-35.3, 16.6), (-33.0, 16.5), (-30.6, 16.3), (-28.2, 16.0), (-25.8, 15.7), (-23.4, 15.4), (-21.1, 15.0), (-18.7, 14.6), (-16.3, 14.2)),
        ((-42.5, 26.0), (-40.1, 25.9), (-37.7, 25.8), (-35.3, 25.6), (-33.0, 25.5), (-30.6, 25.4), (-28.2, 25.3), (-25.8, 25.1), (-23.4, 24.9), (-21.0, 24.8), (-18.6, 24.7), (-16.2, 24.6), (-13.9, 23.8)),
        ((-44.0, 35.0), (-41.7, 35.5), (-39.3, 35.9), (-37.0, 36.4), (-34.7, 37.2), (-32.4, 37.9), (-30.1, 38.6), (-27.9, 39.4), (-25.5, 40.0), (-23.3, 40.7))),
}
CORNICE_G = (
    (38.98, 38.30, 37.78, 37.57, 37.05, 36.85, 36.64, 35.71, 34.93),
    (39.33, 38.47, 37.95, 37.75, 37.23, 37.02, 36.82, 35.88, 35.11),
    (39.68, 38.65, 38.13, 37.92, 37.41, 37.20, 37.00, 36.09, 35.32),
    (39.86, 38.83, 38.33, 38.12, 37.62, 37.41, 37.21, 36.30, 35.53),
    (39.96, 39.04, 38.54, 38.33, 37.83, 37.62, 37.42, 36.51, 35.74),
    (39.87, 39.02, 38.59, 38.42, 37.99, 37.82, 37.63, 36.72, 35.85),
    (39.79, 38.93, 38.50, 38.33, 37.91, 37.73, 37.56, 36.81, 35.93),
    (39.70, 38.84, 38.42, 38.26, 37.85, 37.69, 37.53, 36.72, 35.79),
    (39.63, 38.82, 38.41, 38.25, 37.84, 37.68, 37.52, 36.58, 35.64),
    (39.62, 38.80, 38.40, 38.24, 37.83, 37.67, 37.51, 36.44, 35.50),
    (39.60, 38.79, 38.39, 38.23, 37.82, 37.66, 37.42, 36.29, 35.36),
    (39.28, 38.65, 38.34, 38.21, 37.77, 37.52, 37.27, 36.12, 35.16),
    (38.93, 38.32, 38.04, 37.92, 37.41, 37.18, 36.95, 35.92, 34.97),
    (38.64, 38.07, 37.79, 37.56, 36.99, 36.76, 36.53, 35.49, 34.63),
)
def cirque_ribs(face, k):
    """The cirque's ribs of rock down one face's fall lines from under its
    crest to the forest (RIBS), mid slate, snow couloirs between them; bare
    where a facet is steeper than 30 degrees (crag()'s paler pair, snow on
    all but its steepest facets, read as lavender sheets at a rib's size),
    one grey all round (its shade pair broke the flanks into dark square
    insets). Draped: across a fall line the land lies near level, so the
    drape follows only its run. Its seeds are the ones each rib had beside
    the face's first, dropped."""
    ox, oz = RIB_AT[face]
    def build():
        for i, spine in enumerate(RIBS[face]):
            crag([(x - ox, z - oz) for x, z in spine], ((0.0, 3.0), (0.25, 3.8), (0.7, 2.9), (1.0, 1.6)),
                 seed=62.0 + 7 * k + i, sink=1.8, rock=(ROCK, ROCK), snow=0.86)
    draped('ribs', build)

@piece(1.0)
def avalanche_ribs_w():
    # Avalanche: the west massif's east face, its rock (cirque_ribs), its
    # land untouched (tracks.js avalanche `land`, which both cirque
    # galleries' cuts are sampled on). Placed at u 0.7075, lat 38.7, yaw
    # 24.87, the frame the world's (+X east, +Z south).
    cirque_ribs('w', 0)

@piece(1.0)
def avalanche_ribs_slide():
    # Avalanche: the slide mountain's flanks either side of its chute, their
    # rock (cirque_ribs); over the slide's crown a cornice, a curling lip of
    # snow its blue shadow toward the road, a band of rock under it. Placed
    # at u 0.766, lat 42.97, yaw -29.84, the frame the world's.
    cirque_ribs('slide', 1)
    # the cornice: built at the drawn ground's own heights (CORNICE_G), for a
    # lip that overhangs cannot be laid on the slope under it
    ox, oz = RIB_AT['slide']
    c0, t, n = (-56.54 - ox, 12.96 - oz), (0.374, 0.927), (0.927, -0.374)
    C = (-3.0, -1.0, 0.0, 0.4, 1.4, 1.8, 2.2)
    rows = []
    for i, g in enumerate(CORNICE_G):
        s = -10.0 + 1.5 * i
        end = smooth01(min(i, len(CORNICE_G) - 1 - i) / 2.5)
        lip = (0.8 + 0.35 * wobble(s, 71.0, 6.0)) * end
        g0 = g[2]
        prof = [(C[0], g[0] - 0.3), (C[1], g[1] + 0.7 * end), (C[2] + 0.4 * lip, g0 + 1.4 * lip + 0.05),
                (C[4] + 0.6 * lip, g0 + 1.25 * lip + 0.05), (C[6] + 0.3 * lip, g0 + 0.8 * lip + 0.05),
                (C[4] + 0.2 * lip, g0 + 0.35 * lip), (C[3], g[3] - 0.25)]
        rows.append([(c0[0] + t[0] * s + n[0] * c, y, c0[1] + t[1] * s + n[1] * c) for c, y in prof])
    for o in sheet(rows, lambda i, j, nn: 'sky' if nn[1] < 0.2 else SNOW, 'cornice'):
        snowy(o, 0.3)
    for i in (3, 7, 10):           # held up from the plain inside the mountain (set-check)
        s, g3 = -10.0 + 1.5 * i, CORNICE_G[i][3]
        box((0.3, g3 + 0.1, 0.3), (c0[0] + t[0] * s + n[0] * 0.4, g3 / 2 - 0.1, c0[1] + t[1] * s + n[1] * 0.4),
            SNOW)['chamfer'] = 0
    # the rock band under the lip, on the crest's shoulder where it lies near level
    def band():
        crag([(c0[0] + t[0] * s + n[0] * 4.2, c0[1] + t[1] * s + n[1] * 4.2) for s in (-8.0, -4.0, 0.0, 4.0, 8.0)],
             ((0.0, 1.2), (0.3, 2.2), (0.7, 2.0), (1.0, 1.0)), seed=83.0, sink=1.5, rock=(ROCK, ROCK))
    draped('band', band)

# avalanche_debris_lobe (scratch/lobe8.mjs, the drawn ground sampled): its blocks (x, z, ground,
# size, yaw, kind: 0 in a heap on a toe, 1 the plough's bank, 11 on the layer under it); its
# snapped trunks (root x, y, z, tip x, y, z, girth), the ground under both ends; the two
# tongues' outlines, rows from the toe up (draped).
LOBE = (
    (-5.89, -0.54, 0.16, 1.13, 1.49, 0),
    (-7.96, 1.78, 1.84, 1.24, -2.70, 0),
    (-6.66, 5.42, 1.12, 0.96, 0.55, 0),
    (-5.89, 2.05, 0.28, 1.23, -0.79, 0),
    (-8.07, 3.16, 2.11, 1.32, 3.22, 0),
    (-6.63, 0.50, 0.67, 1.09, 1.39, 0),
    (-7.48, -0.88, 1.16, 1.10, -2.82, 0),
    (-6.69, 2.99, 0.94, 1.08, 0.17, 0),
    (-6.05, -0.35, 0.21, 0.79, 1.39, 11),
    (-8.12, 1.97, 1.98, 0.87, 2.58, 11),
    (-7.22, 6.82, 1.72, 1.26, -2.50, 0),
    (-5.91, 7.03, 0.77, 1.20, 0.40, 0),
    (-7.45, 4.37, 1.71, 0.99, 3.22, 0),
    (-5.51, 5.21, 0.28, 1.04, 3.12, 0),
    (-6.08, 4.08, 0.51, 1.36, 2.07, 0),
    (-8.29, 4.98, 2.34, 1.01, -2.71, 0),
    (-7.39, 7.01, 1.83, 0.88, 0.78, 11),
    (-6.07, 7.23, 0.91, 0.84, 2.34, 11),
    (8.56, 0.21, -0.00, 1.02, 0.45, 0),
    (5.96, 0.55, -0.00, 1.04, 0.96, 0),
    (7.38, 0.15, -0.00, 0.91, -0.49, 0),
    (6.93, 1.30, -0.00, 1.00, -0.18, 0),
    (6.45, -0.64, -0.00, 0.92, 1.11, 0),
    (7.88, 1.14, -0.00, 0.91, -0.60, 0),
    (7.68, -0.82, -0.00, 1.02, 2.06, 0),
    (8.39, 0.40, -0.00, 0.71, 2.78, 11),
    (5.80, 0.74, -0.00, 0.73, 0.08, 11),
    (9.41, 0.85, -0.00, 1.01, 2.79, 0),
    (4.94, -4.98, -0.00, 0.77, -2.79, 1),
    (4.77, -4.11, -0.00, 0.73, -0.65, 1),
    (4.21, -3.39, -0.00, 0.88, 1.74, 1),
    (4.01, -2.54, -0.00, 0.72, 0.52, 1),
    (3.77, -1.69, -0.00, 0.73, 1.56, 1),
    (4.03, -1.38, -0.00, 0.52, 1.96, 11),
    (3.75, 0.04, -0.00, 0.96, 0.88, 1),
    (3.71, 1.80, -0.00, 0.81, -2.85, 1),
    (4.33, 2.56, -0.00, 0.88, 3.17, 1),
    (4.12, 3.54, -0.00, 0.91, 0.28, 1),
    (4.48, 3.70, -0.00, 0.65, -0.58, 11),
    (5.00, 5.02, -0.00, 0.94, 1.91, 1),
    (5.38, 5.11, -0.00, 0.68, 3.25, 11),
    (-1.19, -9.29, -0.00, 0.85, 0.98, 1),
    (-1.83, -8.02, -0.00, 0.81, 1.15, 1),
    (-2.41, -6.73, -0.00, 0.90, -1.51, 1),
    (-3.90, -1.21, -0.00, 0.90, -2.66, 1),
    (-4.22, -0.78, -0.00, 0.65, -0.44, 11),
    (-3.66, 0.25, -0.00, 0.97, 1.67, 1),
    (-3.53, 1.68, -0.00, 0.83, -2.30, 1),
    (-3.78, 2.14, -0.00, 0.60, 0.80, 11),
    (-3.32, 3.07, -0.00, 0.88, 2.23, 1),
    (-3.54, 3.55, -0.00, 0.63, 2.96, 11),
    (-3.04, 4.46, -0.00, 0.92, -1.95, 1),
    (-2.98, 5.90, -0.00, 0.73, -1.16, 1),
    (-2.27, 7.19, -0.00, 0.95, 2.02, 1),
    (-1.94, 8.64, -0.00, 0.81, -0.70, 1),
    (-0.95, 9.74, -0.00, 0.73, 0.07, 1),
    (-0.51, 11.12, -0.00, 0.81, 0.57, 1),
    (0.31, 12.26, -0.00, 0.89, 3.20, 1))
LOBE_LOGS = (
    (-6.16, 0.33, 1.25, -6.40, 0.81, 4.43, 1.31),
    (-8.76, 2.66, 3.68, -8.19, 2.33, 6.76, 1.32),
    (-8.32, 1.63, -1.51, -8.58, 2.24, 1.50, 1.48),
    (9.21, -0.00, 0.04, 9.83, -0.00, 0.79, 1.46))
LOBE_TONGUES = (
    (((-2.82, -9.78), (-3.40, -8.59), (-4.05, -7.44), (-4.69, -6.26), (-5.16, -4.99), (-5.37, -3.67), (-5.37, -2.32), (-5.30, -0.97), (-5.29, 0.37), (-5.36, 1.71), (-5.42, 3.05), (-5.31, 4.39), (-4.95, 5.66), (-4.38, 6.88), (-3.72, 8.07), (-3.10, 9.27), (-2.57, 10.50), (-2.06, 11.70), (-1.44, 12.83), (-0.62, 13.83), (0.39, 14.70)),
     ((-4.16, -9.14), (-4.86, -8.04), (-5.43, -6.85), (-5.79, -5.58), (-5.93, -4.28), (-5.96, -2.97), (-6.01, -1.67), (-6.13, -0.35), (-6.30, 0.97), (-6.38, 2.29), (-6.27, 3.59), (-5.93, 4.86), (-5.42, 6.05), (-4.87, 7.24), (-4.36, 8.45), (-3.91, 9.71), (-3.46, 10.96), (-2.91, 12.11), (-2.19, 13.13), (-1.30, 14.03), (-0.32, 14.86)),
     ((-5.43, -8.97), (-5.93, -7.84), (-6.24, -6.65), (-6.41, -5.42), (-6.52, -4.20), (-6.65, -3.00), (-6.86, -1.80), (-7.09, -0.56), (-7.26, 0.70), (-7.28, 1.94), (-7.09, 3.16), (-6.73, 4.34), (-6.30, 5.49), (-5.88, 6.60), (-5.51, 7.77), (-5.18, 8.98), (-4.80, 10.20), (-4.31, 11.36), (-3.68, 12.37), (-2.92, 13.27), (-2.07, 14.09)),
     ((-6.47, -8.42), (-6.72, -7.26), (-6.91, -6.09), (-7.10, -4.95), (-7.35, -3.83), (-7.64, -2.70), (-7.92, -1.54), (-8.11, -0.33), (-8.13, 0.88), (-7.98, 2.06), (-7.69, 3.20), (-7.35, 4.32), (-7.01, 5.43), (-6.74, 6.53), (-6.51, 7.67), (-6.25, 8.85), (-5.88, 10.02), (-5.36, 11.14), (-4.71, 12.11), (-3.98, 12.97), (-3.21, 13.78)),
     ((-7.36, -7.12), (-7.62, -6.14), (-7.92, -5.17), (-8.23, -4.20), (-8.54, -3.21), (-8.78, -2.20), (-8.91, -1.15), (-8.91, -0.07), (-8.79, 0.98), (-8.58, 2.00), (-8.35, 3.00), (-8.12, 3.99), (-7.93, 4.99), (-7.78, 5.98), (-7.64, 6.98), (-7.46, 8.00), (-7.19, 9.03), (-6.79, 10.03), (-6.27, 10.97), (-5.66, 11.85), (-5.03, 12.63)),
     ((-8.14, -7.25), (-8.53, -6.27), (-8.92, -5.28), (-9.25, -4.27), (-9.50, -3.24), (-9.62, -2.17), (-9.62, -1.07), (-9.51, 0.03), (-9.35, 1.10), (-9.17, 2.15), (-9.03, 3.18), (-8.93, 4.22), (-8.84, 5.28), (-8.74, 6.32), (-8.58, 7.35), (-8.30, 8.39), (-7.89, 9.40), (-7.36, 10.38), (-6.75, 11.31), (-6.12, 12.20), (-5.53, 13.02)),
     ((-9.58, -6.34), (-9.89, -5.44), (-10.11, -4.51), (-10.24, -3.56), (-10.27, -2.59), (-10.23, -1.61), (-10.16, -0.61), (-10.07, 0.37), (-9.99, 1.33), (-9.95, 2.27), (-9.93, 3.22), (-9.91, 4.18), (-9.86, 5.14), (-9.75, 6.09), (-9.56, 7.00), (-9.27, 7.91), (-8.89, 8.81), (-8.43, 9.69), (-7.92, 10.55), (-7.40, 11.40), (-6.90, 12.25))),
    (((6.78, -4.33), (6.32, -3.81), (5.89, -3.25), (5.66, -2.61), (5.65, -1.91), (5.76, -1.21), (5.80, -0.55), (5.68, 0.06), (5.49, 0.73), (5.41, 1.42), (5.56, 2.09), (5.91, 2.72), (6.31, 3.29), (6.58, 3.86), (6.71, 4.47), (6.86, 5.17), (7.17, 5.85)),
     ((7.08, -3.73), (6.80, -3.27), (6.68, -2.75), (6.70, -2.20), (6.76, -1.66), (6.75, -1.14), (6.63, -0.66), (6.43, -0.19), (6.26, 0.31), (6.22, 0.83), (6.35, 1.35), (6.62, 1.83), (6.91, 2.30), (7.13, 2.78), (7.22, 3.26), (7.25, 3.76), (7.31, 4.27)),
     ((7.76, -3.19), (7.72, -2.73), (7.75, -2.26), (7.76, -1.82), (7.68, -1.40), (7.50, -1.00), (7.28, -0.59), (7.11, -0.19), (7.07, 0.22), (7.18, 0.65), (7.40, 1.07), (7.63, 1.47), (7.80, 1.88), (7.86, 2.32), (7.85, 2.77), (7.83, 3.21), (7.91, 3.62)),
     ((8.77, -2.75), (8.78, -2.32), (8.74, -1.94), (8.59, -1.58), (8.36, -1.23), (8.12, -0.86), (7.98, -0.49), (7.99, -0.12), (8.13, 0.25), (8.34, 0.62), (8.51, 0.99), (8.58, 1.37), (8.55, 1.78), (8.49, 2.23), (8.48, 2.64), (8.59, 2.99), (8.84, 3.26)),
     ((9.46, -1.67), (9.26, -1.45), (9.06, -1.20), (8.93, -0.94), (8.89, -0.66), (8.94, -0.38), (9.06, -0.14), (9.20, 0.10), (9.32, 0.35), (9.37, 0.61), (9.35, 0.88), (9.28, 1.17), (9.20, 1.47), (9.16, 1.79), (9.19, 2.09), (9.31, 2.33), (9.50, 2.52)),
     ((10.07, -1.48), (9.91, -1.27), (9.84, -1.02), (9.86, -0.76), (9.96, -0.50), (10.09, -0.27), (10.19, -0.07), (10.23, 0.12), (10.19, 0.34), (10.09, 0.59), (9.98, 0.85), (9.91, 1.12), (9.91, 1.38), (10.02, 1.64), (10.20, 1.84), (10.41, 1.99), (10.61, 2.12)),
     ((10.81, -0.97), (10.88, -0.78), (10.96, -0.60), (11.05, -0.43), (11.10, -0.29), (11.12, -0.16), (11.08, -0.05), (11.01, 0.07), (10.90, 0.22), (10.80, 0.38), (10.73, 0.56), (10.69, 0.73), (10.72, 0.90), (10.80, 1.05), (10.94, 1.20), (11.10, 1.35), (11.25, 1.46))))

def lying_trunk(p0, p1, k):
    """A trunk a slide snapped and laid down, from its broken root end `p0`
    to its top `p1` (points on the drawn ground), pitched to the ground
    between them so neither end stands off it; a jagged shard at the break.
    Lay it along a slope's contour: down the fall line, seen from below, it
    stands up as a stake."""
    dx, dy, dz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
    run = math.hypot(dx, dz)
    yaw, pitch = math.atan2(dx, dz), math.atan2(dy, run)
    r = 0.14 * k
    o = cyl(r, math.hypot(run, dy), (p0[0], p0[1] + 0.7 * r, p0[2]), 0x7a5a3a, r2=0.09 * k, segs=6,
            axis='along', yaw=yaw, stem=True)
    o.rotation_euler.x = math.radians(90) - pitch
    box((0.17 * k, 0.24 * k, 0.12 * k), (p0[0], p0[1] + 0.12 * k, p0[2]), 0x8a6a46, yaw=yaw, roll=0.5)

def debris_tongue(rows, seed):
    """A tongue of slide debris lying on the drawn ground (draped): its
    outline `rows`, from the toe up, raised in low lumps of packed snow,
    highest in a lip along the toe, its rim sunk under the snow. All snow:
    lumps with a pale blue shaded side read from the road as flat blue
    shards strewn on a dome."""
    nr, nc = len(rows), len(rows[0])
    pts = []
    for i, row in enumerate(rows):
        r = []
        for j, (x, z) in enumerate(row):
            rim = min(i, nr - 1 - i, j, nc - 1 - j)
            if rim == 0:
                y = -0.12
            else:
                env = smooth01(rim / 2.0) * (1.0 + 0.8 * smooth01(1.0 - (i - 1) / 2.0))
                lump = 0.5 + 0.5 * math.sin(x * 1.7 + 2.1 * math.sin(z * 0.9 + seed)) * math.sin(z * 1.9 + 1.3 * math.sin(x * 1.1))
                y = env * (0.06 + 0.24 * lump + 0.08 * jitter(i, j, seed))
            r.append((x, y, z))
        pts.append(r)
    for o in sheet(pts, lambda i, j, n: SNOW, 'tongue'):
        snowy(o, 0.3)

@piece(1.0)
def avalanche_cabin():
    # Avalanche: the log cabin by the crossing, its chimney smoking, at its
    # real size beside a car (a set piece, so it stands where it is put: the
    # theme's procedural cabin re-rolled its spot whenever a piece's
    # footprint moved, and came to the kerb, where its roof read as a slab
    # on a crate). Placed at u 0.232, lat -17.5, yaw 150, door on +X.
    log_cabin_at(0.0, 0.0, 0.58, smoke=True)
    join_still('cabin')

@piece(1.0)
def avalanche_debris_lobe():
    # Avalanche: where the first path's slide came down to the road, crossed
    # it and was ploughed through: its run-out a low tongue of packed snow
    # on the toe each side of the road, a few heaps of big blocks on them
    # and the road cleared, a bank of blocks each side; trunks the slide
    # snapped lying on the debris. The path above stays forest either side
    # of its trimmed edge (forest-a): debris strewn up the face, blocks and
    # blue shards, read as speckle on a bald dome. No rock in it and no
    # uprooted fir (a green lump by a dark disc of roots read as a crashed
    # toy).
    # Each block and trunk stands at the ground drawn under it (LOBE, sampled:
    # draped, a block on the near ramp's step stretched into a stack of ice),
    # held up from the plain where the land is raised; the tongues are draped.
    # Placed at u 0.276, lat 0, yaw 0: +X left, +Z forward; the warning sign
    # at its foot stays clear.
    before = set(bpy.context.scene.objects)
    for i, (x, z, g, s, yaw, kind) in enumerate(LOBE):
        lift = g + (0.32 if kind == 11 else (0.12 if kind == 0 else -0.1 * s))
        squat = 0.72 if kind == 0 else 0.8
        stone(x, z, s, yaw, 1.0 + i * 0.37, squat=squat, rock=(SNOW, 'sky'), y=lift)
        # a lump is hollow: held under its foot's ring, not its middle
        hx, hz, top = x + 0.5 * s * math.cos(yaw), z - 0.5 * s * math.sin(yaw), lift - 0.06 * s * squat
        if top > 0.02:                   # held up from the plain inside the land (set-check)
            box((0.2, top + 0.1, 0.2), (hx, top / 2 - 0.05, hz), SNOW)['chamfer'] = 0
    for o in set(bpy.context.scene.objects) - before:
        if o.get('swatch') == 'sky':     # the blue in a block's shade, not greyed down the ramp
            snowy(o, 0.35)
    for x0, y0, z0, x1, y1, z1, k in LOBE_LOGS:
        lying_trunk((x0, y0 + 0.28, z0), (x1, y1 + 0.28, z1), k)     # on the tongue's lumps
        for x, g, z in ((x0, y0 + 0.28, z0), (x1, y1 + 0.28, z1)):  # held up from the plain (set-check)
            box((0.2, g + 0.1, 0.2), (x, g / 2 - 0.05, z), 0x7a5a3a)['chamfer'] = 0
    join_still('lobe')
    for k, rows in enumerate(LOBE_TONGUES):
        draped('tongue%d' % k, lambda: debris_tongue(rows, 7.0 + 3.0 * k))

@piece(1.0)
def avalanche_gallery():
    # Avalanche: the long gallery on the straight after the slide, the cut
    # it is let into, and rock fallen at its mouths.
    pull = lambda i: smooth01((i - 32) / 3.0)          # the land's bank by the far mouth
    rows = cut_face(ROAD_A, FACE_A, 0, 40, 7, 35, seed=3.0, ledge=5.0,
                    verge=lambda i: 6.5 + 0.4 * smooth01((8 - i) / 3.0) - 1.6 * pull(i), inner=lambda i: 5.9 - 1.0 * pull(i))
    # ice where water seeps out of the rock at both mouths and along the face
    # the racer runs beside under the roof, firs along its top
    cut_ice(rows, 0, seeps=(3, 5, 37), firs=(4, 36, 38), seed=5.0)   # at the mouths: under the roof a curtain hung in the dark
    gallery_shed(ROAD_A, 7, 35, seed=3.0)
    fallen_rock(ROAD_A, ((3, 6.0, 0.5), (4, 6.5, 0.35), (38, 4.5, 0.5), (39, 4.6, 0.4)))

@piece(1.0)
def avalanche_gallery_short():
    # Avalanche: the shorter gallery on the run to the slide's foot, and the
    # cut through the spur's toe it is let into, which a racer coming round
    # the bend before it looks straight at.
    rows = cut_face(ROAD_B, FACE_B, 1, 29, 15, 24, seed=11.0, ledge=5.0,
                    verge=lambda i: 6.5 + 1.4 * smooth01((14 - i) / 3.0) + 0.35 * smooth01((i - 24) / 2.0),
                    inner=lambda i: 5.9)
    # ice seeping down the face the bend looks at, firs along its top
    cut_ice(rows, 1, seeps=(6, 9, 12, 26), firs=(5, 8, 11), seed=13.0)
    gallery_shed(ROAD_B, 15, 24, seed=11.0)
    # rock fallen at the far mouth only: half buried in the bank at the
    # cut's foot by the bend, a stone showed as a white fleck or a dark claw
    fallen_rock(ROAD_B, ((26, 6.2, 0.45),))

# The box's machines (the lite build) leave out what a cell there never
# resolves: grilles, mirrors, lamps, hazard blocks, the ladder, the hubs.
WORKS_LITE = False

def works_wheel(at, yaw, k, r=0.3):
    """A works truck's wheel at `at` (its hub's middle), its axle across the
    truck: a fat dark tyre with a grey hub standing proud either side."""
    c, s2 = math.cos(yaw), math.sin(yaw)
    x, y, z = at
    w = 0.26 * k
    cyl(r * k, w, (x - c * w / 2, y, z + s2 * w / 2), 0x38383d, axis='across', yaw=yaw, segs=10, stem=True)
    if not WORKS_LITE:
        cyl(r * 0.5 * k, w + 0.06 * k, (x - c * (w / 2 + 0.03 * k), y, z + s2 * (w / 2 + 0.03 * k)), 0x868ba1,
            axis='across', yaw=yaw, segs=8, stem=True)

def rotary_plough(x, z, yaw, rotor, k=1.0, y=0.0):
    """A rotary snowplough (a snow blower on a works truck) facing +Z turned
    by `yaw`, `k` times a little over two and a half long, built from `y`:
    four wheels under dark arches, the engine deck behind with its grille
    and a capped exhaust stack, the orange cab glazed on three sides under a
    white roof with a beacon bar and two work lamps, mirrors out on stalks;
    on the nose the blower's wide intake box, hazard blocks along its top
    edge and skids at its sides, the reel turning in its dark mouth
    (`rotor`, a part riding on the piece, about the truck's own across), and
    over it the chute, a square duct bent out to the side under a hood,
    throwing its jet of snow onto the bank beside it (one arc of white
    blocks from the hood to the heap it lands in, so none of it hangs in
    the air)."""
    c, s2 = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + (dx * c + dz * s2) * k, y + dy * k, z + (-dx * s2 + dz * c) * k)
    def sz(*v):
        return tuple(e * k for e in v)
    ORANGE, DARK, GREY, GLASS, WHITE, AMBER = 0xff7e44, 0x38383d, 0x868ba1, 0x2f3a4a, 0xfff6eb, 0xffc044
    for sd in (-1, 1):
        for dz in (-0.8, 0.5):
            works_wheel(at(sd * 0.66, 0.3, dz), yaw, k)
            box(sz(0.34, 0.1, 0.78), at(sd * 0.66, 0.66, dz), DARK, yaw=yaw)           # its arch
    box(sz(1.1, 0.24, 2.3), at(0, 0.5, -0.15), DARK, yaw=yaw)                           # the chassis
    box(sz(1.3, 0.62, 1.15), at(0, 0.98, -0.75), ORANGE, yaw=yaw)                       # the engine deck
    for sd in (-1, 1):                                                                  # its grilles
        if not WORKS_LITE:
            for g in range(3):
                box(sz(0.06, 0.08, 0.8), at(sd * 0.66, 0.84 + 0.15 * g, -0.75), DARK, yaw=yaw)
    if not WORKS_LITE:
        box(sz(1.34, 0.08, 1.19), at(0, 1.32, -0.75), GREY, yaw=yaw)                        # its lid
    box(sz(0.12, 0.75, 0.12), at(-0.45, 1.7, -0.3), DARK, yaw=yaw)                      # the exhaust
    if not WORKS_LITE:
        box(sz(0.18, 0.06, 0.18), at(-0.45, 2.1, -0.3), GREY, yaw=yaw)
    box(sz(1.24, 0.95, 0.9), at(0, 1.2, 0.3), ORANGE, yaw=yaw)                          # the cab
    box(sz(1.0, 0.4, 0.06), at(0, 1.36, 0.76), GLASS, yaw=yaw)                          # windscreen
    for sd in (-1, 1):
        box(sz(0.06, 0.4, 0.6), at(sd * 0.63, 1.36, 0.32), GLASS, yaw=yaw)              # side glass
        if not WORKS_LITE:
            box(sz(0.06, 0.2, 0.12), at(sd * 0.8, 1.42, 0.72), DARK, yaw=yaw)               # mirrors
        if not WORKS_LITE:
            box(sz(0.2, 0.05, 0.05), at(sd * 0.7, 1.42, 0.72), DARK, yaw=yaw)
        if not WORKS_LITE:
            box(sz(0.16, 0.12, 0.08), at(sd * 0.42, 1.8, 0.72), WHITE, yaw=yaw)             # work lamps
        if not WORKS_LITE:
            box(sz(0.2, 0.14, 0.06), at(sd * 0.44, 0.78, 0.77), WHITE, yaw=yaw)             # headlamps
    box(sz(1.3, 0.1, 0.96), at(0, 1.72, 0.3), WHITE, yaw=yaw)                           # the roof
    box(sz(0.7, 0.14, 0.2), at(0, 1.84, 0.2), AMBER, yaw=yaw)                           # the beacon bar
    # the blower: its intake box open to the front, the reel in its mouth
    box(sz(0.5, 0.2, 0.5), at(0, 0.62, 0.95), DARK, yaw=yaw)                            # the arms it rides on
    box(sz(2.0, 0.12, 0.7), at(0, 1.2, 1.5), ORANGE, yaw=yaw)                           # top
    box(sz(2.0, 1.0, 0.1), at(0, 0.7, 1.2), ORANGE, yaw=yaw)                            # back
    box(sz(1.8, 0.9, 0.08), at(0, 0.68, 1.28), DARK, yaw=yaw)                           # the mouth's dark
    for sd in (-1, 1):
        box(sz(0.1, 1.06, 0.74), at(sd * 0.98, 0.7, 1.5), ORANGE, yaw=yaw)              # cheeks
        box(sz(0.14, 0.1, 0.9), at(sd * 0.98, 0.14, 1.5), GREY, yaw=yaw)                # skids
    if not WORKS_LITE:
        for g in range(5):                                                                  # hazard blocks
            box(sz(0.4, 0.14, 0.08), at(-0.8 + 0.4 * g, 1.2, 1.87), AMBER if g % 2 == 0 else DARK, yaw=yaw)
    with animated(rotor, at(0, 0.62, 1.58), yaw):
        box(sz(1.76, 0.22, 0.22), at(0, 0.62, 1.58), GREY, yaw=yaw)                      # the reel's shaft
        for i in range(4):
            a = i * math.pi / 2
            for sd in (-1, 1):                                                           # paddles
                box(sz(0.8, 0.08, 0.3), at(sd * 0.44, 0.62 + 0.2 * math.cos(a), 1.58 + 0.2 * math.sin(a)),
                    0xcf534f, yaw=yaw, pitch=-a)
    # the chute and its jet, thrown over the truck's left (-X) onto the bank
    box(sz(0.34, 1.1, 0.34), at(0.3, 1.8, 1.4), ORANGE, yaw=yaw)
    box(sz(0.9, 0.34, 0.4), at(-0.05, 2.3, 1.4), ORANGE, yaw=yaw)
    box(sz(0.1, 0.42, 0.46), at(-0.5, 2.3, 1.4), DARK, yaw=yaw)
    jet = [(-0.45, 2.32), (-1.1, 2.5), (-1.75, 2.42), (-2.35, 2.1), (-2.85, 1.6), (-3.2, 0.95), (-3.45, 0.3)]
    for i, ((xa, ya), (xb, yb)) in enumerate(zip(jet, jet[1:])):
        w = 0.24 + 0.07 * i
        L = math.hypot(xb - xa, yb - ya) + 0.12
        snowy(box(sz(L, w, w + 0.1), at((xa + xb) / 2, (ya + yb) / 2, 1.4), 0xf3f7fb, yaw=yaw,
                  roll=-math.atan2(yb - ya, xb - xa)), 0.5)
    snowy(sphere(0.75 * k, at(-3.5, 0.0, 1.4), 0xf3f7fb, subdiv=1, scale=(1.2, 0.55, 1.3)), 0.5)

def plough_truck(x, z, yaw, k=1.0, y=0.0):
    """A highway plough and gritter parked, facing +Z turned by `yaw`, `k`
    times some three long, built from `y`: three axles under dark arches, a
    yellow cab glazed on three sides under a white roof with its beacons,
    mirrors and lamps, the grey hopper behind ribbed in orange and heaped
    with grit, a ladder up its side and the spinner under its tail; on the
    nose a V of two orange blades, the hazard strip along their top, the
    grey cutting edge below, on its dark lifting arms."""
    c, s2 = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + (dx * c + dz * s2) * k, y + dy * k, z + (-dx * s2 + dz * c) * k)
    def sz(*v):
        return tuple(e * k for e in v)
    YELLOW, ORANGE, DARK, GREY, GLASS, WHITE = 0xffc044, 0xff7e44, 0x38383d, 0x868ba1, 0x2f3a4a, 0xfff6eb
    for sd in (-1, 1):
        for dz in (-1.15, -0.5, 0.75):
            works_wheel(at(sd * 0.66, 0.3, dz), yaw, k)
        box(sz(0.34, 0.1, 1.4), at(sd * 0.66, 0.66, -0.82), DARK, yaw=yaw)
        box(sz(0.34, 0.1, 0.78), at(sd * 0.66, 0.66, 0.75), DARK, yaw=yaw)
    box(sz(1.1, 0.24, 2.9), at(0, 0.5, -0.2), DARK, yaw=yaw)                            # the chassis
    box(sz(1.3, 0.8, 1.85), at(0, 1.08, -0.8), GREY, yaw=yaw)                           # the hopper
    for dz in (-1.6, -0.8, 0.0):                                                        # its ribs
        box(sz(1.38, 0.86, 0.1), at(0, 1.08, dz), ORANGE, yaw=yaw)
    box(sz(1.38, 0.1, 1.9), at(0, 1.5, -0.8), ORANGE, yaw=yaw)                          # its rim
    snowy(sphere(0.62 * k, at(0, 1.5, -0.8), 0xe9eff6, subdiv=1, scale=(0.9, 0.42, 1.3)), 0.5)   # the grit, snowed on
    if not WORKS_LITE:
        for g in range(4):                                                                  # the ladder
            box(sz(0.06, 0.06, 0.34), at(0.7, 0.72 + 0.22 * g, -1.2), DARK, yaw=yaw)
    if not WORKS_LITE:
        for dz in (-1.36, -1.04):
            box(sz(0.06, 0.9, 0.06), at(0.7, 1.05, dz), DARK, yaw=yaw)
    box(sz(0.5, 0.3, 0.3), at(0, 0.6, -1.85), DARK, yaw=yaw)                            # the spinner's chute
    cyl(0.36 * k, 0.07 * k, at(0, 0.34, -1.95), ORANGE, segs=10)                        # the spinner
    box(sz(1.24, 0.95, 0.95), at(0, 1.2, 0.72), YELLOW, yaw=yaw)                        # the cab
    box(sz(1.0, 0.4, 0.06), at(0, 1.36, 1.2), GLASS, yaw=yaw)
    for sd in (-1, 1):
        box(sz(0.06, 0.4, 0.62), at(sd * 0.63, 1.36, 0.76), GLASS, yaw=yaw)
        if not WORKS_LITE:
            box(sz(0.06, 0.2, 0.12), at(sd * 0.8, 1.42, 1.16), DARK, yaw=yaw)
        if not WORKS_LITE:
            box(sz(0.2, 0.05, 0.05), at(sd * 0.7, 1.42, 1.16), DARK, yaw=yaw)
        if not WORKS_LITE:
            box(sz(0.2, 0.14, 0.06), at(sd * 0.44, 0.84, 1.21), WHITE, yaw=yaw)             # headlamps
        if not WORKS_LITE:
            box(sz(0.16, 0.12, 0.16), at(sd * 0.48, 1.84, 0.72), 0xff7e44, yaw=yaw)         # beacons
    if not WORKS_LITE:
        box(sz(1.0, 0.2, 0.08), at(0, 0.84, 1.22), DARK, yaw=yaw)                           # the grille
    box(sz(1.3, 0.1, 1.0), at(0, 1.72, 0.72), WHITE, yaw=yaw)                           # the roof
    box(sz(0.12, 0.7, 0.12), at(0.52, 1.75, 0.18), DARK, yaw=yaw)                       # the exhaust
    # the V plough on its arms
    for sd in (-1, 1):
        box(sz(0.12, 0.14, 0.7), at(sd * 0.3, 0.5, 1.5), DARK, yaw=yaw)
        a = yaw + sd * 0.5
        box(sz(1.25, 0.62, 0.12), at(sd * 0.55, 0.52, 1.72), ORANGE, yaw=a, pitch=-0.18)
        box(sz(1.27, 0.12, 0.13), at(sd * 0.55, 0.86, 1.67), DARK, yaw=a, pitch=-0.18)   # the hazard strip
        if not WORKS_LITE:
            for g in range(2):
                box(sz(0.3, 0.13, 0.14), at(sd * (0.25 + 0.6 * g), 0.86, 1.86 - 0.33 * g), YELLOW, yaw=a, pitch=-0.18)
        box(sz(1.27, 0.1, 0.1), at(sd * 0.55, 0.2, 1.78), GREY, yaw=a)                   # the cutting edge
    box(sz(0.2, 0.7, 0.2), at(0, 0.55, 2.05), ORANGE, yaw=yaw)                          # the V's nose

@piece(1.0)
def avalanche_gallery_loop_lite():
    global WORKS_LITE
    WORKS_LITE = True
    avalanche_gallery_loop()
    WORKS_LITE = False

@piece(1.0)
def avalanche_gallery_loop():
    # Avalanche: the third gallery, on the run west along the top loop's
    # north side where the third avalanche path comes down to the road (its
    # churned snow is tracks.js `land`'s paint), let into the cut through
    # the mountainside's foot (land ridge u 0.3517, `near` the kerb, steep as
    # the cirque's). Built as the other two are (cut_face, gallery_shed) on
    # ROAD_C / FACE_C. At its east mouth the plough at work: a rotary plough
    # eating into the snow the path brought down onto the verge, its
    # impeller turning, a plough truck parked behind it; orange and red on
    # white. Placed at u 0.37, lat 0, yaw 0.
    cut_face(ROAD_C, FACE_C, 0, 32, 4, 28, seed=17.0, ledge=5.0,
             verge=lambda i: 6.5, inner=lambda i: 5.9)
    gallery_shed(ROAD_C, 4, 28, seed=17.0)
    # On the verge: each machine a part of its own standing LEVEL on the land
    # under its middle (anim_drape; draped vertex by vertex, as they were, a
    # truck leaned and sheared with the bank), sunk a little into a bed of
    # packed snow that does lie on the bank as drawn (drape_), so no wheel
    # hangs over the low side. Each idles: a shiver of the engine, no more.
    yw = road_yaw(ROAD_C, 0)
    x, _, z = on_road(ROAD_C, 0, -5.6, 0)
    before = set(bpy.context.scene.objects)
    hx, _, hz = on_road(ROAD_C, 2, -5.4, 0)
    mound(0.75, hx, hz, 1.1, 1.1, 1.8, color=0xf3f7fb, rings=4, segs=12, sink=0.3, shape=1.2)
    for (bx, bz, bl) in ((x, z - 0.9, 3.9), (x + 0.2, z - 6.2, 4.6)):
        mound(0.42, bx, bz, 2.3, 2.3, bl / 2 + 1.2, color=0xf3f7fb, rings=4, segs=12, sink=0.3, shape=0.7)
    # The depot's lane: how the machines get onto the road. A ploughed strip
    # from under them back along the verge and down to the kerb behind them
    # (a racer comes on its mouth first, then the machines), their wheel
    # ruts in it, a bank of thrown snow along both sides, orange snow poles
    # marking its edges and a red and white boom, raised, at its mouth.
    x0, z0, nx, nz, _ = ROAD_C[0]
    tx, tz = (-nz, nx) if nx > 0 else (nz, -nx)                      # along the road, toward +Z
    def lane(l, t):
        return (x0 + nx * l + tx * t, z0 + nz * l + tz * t)
    line = [(-5.6, 1.0 - 1.0 * i) for i in range(11)]                # under the machines
    line += [(-5.6 + 2.5 * smooth01(i / 7.0), -9.0 - 1.0 * i) for i in range(1, 9)]   # and down to the kerb
    rows, ruts = [], ([], [])
    for l, t in line:
        (ax_, az_), (bx_, bz_) = lane(l - 1.25, t), lane(l + 1.25, t)
        rows.append([(ax_, 0.05, az_), (bx_, 0.05, bz_)])
        for k, off in enumerate((-0.6, 0.6)):
            (cx_, cz_), (dx_, dz_) = lane(l + off - 0.14, t), lane(l + off + 0.14, t)
            ruts[k].append([(cx_, 0.07, cz_), (dx_, 0.07, dz_)])
    for o in sheet(rows, lambda i, j, nn: 'sky', 'lane'):
        snowy(o, 0.3)
    for rr in ruts:
        for o in sheet(rr, lambda i, j, nn: 'lavender', 'rut'):
            snowy(o, 0.3)
    for i, (l, t) in enumerate(line):
        for sd in (-1, 1):
            if i % 2 == (0 if sd < 0 else 1):
                bx_, bz_ = lane(l + sd * 1.75, t)
                snowy(box((0.9, 0.34 + 0.1 * (i % 3), 1.3), (bx_, 0.12, bz_), 0xf3f7fb, yaw=yw + 0.3 * sd * (i % 2)), 0.45)
            if i % 3 == 1:
                px_, pz_ = lane(l + sd * 1.4, t)
                box((0.08, 1.1, 0.08), (px_, 0.55, pz_), 0xff7e44)
                box((0.1, 0.16, 0.1), (px_, 0.92, pz_), 0xfff6eb)
    gl, gt = line[-1]
    px_, pz_ = lane(gl - 1.5, gt + 0.6)
    box((0.22, 1.0, 0.22), (px_, 0.5, pz_), 0xfff6eb)                # the boom's post
    ex_, ez_ = lane(gl - 0.4, gt + 0.6)                              # the boom, up, banded
    strut((px_, 0.9, pz_), (ex_, 3.0, ez_), 0.14, 0xcf534f)
    for f in (0.3, 0.7):
        strut((px_ + (ex_ - px_) * (f - 0.1), 0.9 + 2.1 * (f - 0.1), pz_ + (ez_ - pz_) * (f - 0.1)),
              (px_ + (ex_ - px_) * (f + 0.1), 0.9 + 2.1 * (f + 0.1), pz_ + (ez_ - pz_) * (f + 0.1)), 0.17, 0xfff6eb)
    group([o for o in bpy.context.scene.objects if o not in before and o.type == 'MESH' and o.get('anim') is None],
          'drape_plough')
    with animated('anim_drape+bob:h=0.012:p=0.21#blower', (x, 0.0, z - 0.9)):
        rotary_plough(x, z - 0.9, yw, 'anim_spin:a=x:w=5#rotor', k=1.35, y=0.12)
    with animated('anim_drape+bob:h=0.01:p=0.26#gritter', (x + 0.2, 0.0, z - 6.2)):
        plough_truck(x + 0.2, z - 6.2, yw, k=1.3, y=0.12)

# ====================================================================================
# BACKYARD
# ====================================================================================

def strut(a, b, t, color):
    """A square bar `t` across from glTF point a to b: a ladder rail, a fork."""
    dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
    return box((t, t, math.sqrt(dx * dx + dy * dy + dz * dz)), mid, color,
               yaw=math.atan2(dx, dz), pitch=math.atan2(dy, math.hypot(dx, dz)))

# The backyard is the tiny world at its own scale, the scale the trees and the
# cars already set: a car is a car (0.9 long), so a cottage is two of it, a
# swing comes up to its roof and a church spire stands over the trees. Every
# piece here is authored in METRES (a car 3.6 long, the road 10 wide) and
# grown REAL at export, so the bars, chamfers and plates of the cars' grammar
# keep their proportions at the size of real things. Nothing everyday is
# giant: what is big is land, water and many real things together.
REAL = 0.25

def local(cx, cz, yaw):
    """Points in a frame at (cx, cz) turned by `yaw` (box()'s sense)."""
    c, s = math.cos(yaw), math.sin(yaw)
    return lambda dx, dy, dz: (cx + dx * c + dz * s, dy, cz - dx * s + dz * c)

SKIN = 0xf2bf99
HAIR = (0x7a5a3a, 0x2a2735, 0xffc044, 0xb06041)

def person(at, yaw, shirt, k=1.0, hair=0, legs=0x4f5260, sit=False, arm=0.0, kick=0.0, gesture=None):
    """Someone facing +X turned by `yaw`, 1.9 tall at k 1 (a child is about
    0.7): blocks, the cars' way, about twice life size across so they read.
    Sitting, the seat is at `at` and the legs reach forward off it. `arm`
    lifts the arms forward (radians), to hold a rope or a ribbon. `kick`
    stands them on the left leg with the right swung forward that far
    (radians), a ball just struck. `gesture` names the arms' motion
    (a one-way `anim_sway...:r=` with a rest), turning about the shoulders: the one movement a
    person here makes of their own (set_motion.h)."""
    L = local(at[0], at[2], yaw)
    y = at[1]
    if sit:
        box((0.6 * k, 0.24 * k, 0.44 * k), L(0.2 * k, y + 0.12 * k, 0), legs, yaw=yaw)
        box((0.22 * k, 0.5 * k, 0.44 * k), L(0.42 * k, y - 0.12 * k, 0), legs, yaw=yaw)
        b = y + 0.22 * k
    elif kick:
        box((0.32 * k, 0.86 * k, 0.21 * k), L(0, y + 0.43 * k, 0.11 * k), legs, yaw=yaw)
        box((0.3 * k, 0.86 * k, 0.2 * k), L(0.43 * k * math.sin(kick), y + 0.86 * k - 0.43 * k * math.cos(kick), -0.11 * k),
            legs, yaw=yaw, roll=-kick)
        b = y + 0.84 * k
    else:
        box((0.32 * k, 0.86 * k, 0.44 * k), L(0, y + 0.43 * k, 0), legs, yaw=yaw)
        b = y + 0.84 * k
    box((0.4 * k, 0.64 * k, 0.54 * k), L(0, b + 0.32 * k, 0), shirt, yaw=yaw)
    def arms():
        for s in (-1, 1):
            box((0.2 * k, 0.56 * k, 0.17 * k), L(0.05 * k + 0.28 * k * math.sin(arm), b + 0.58 * k - 0.28 * k * math.cos(arm), s * 0.35 * k),
                shirt, yaw=yaw, roll=-arm)
    if gesture:
        with animated(gesture, L(0.05 * k, b + 0.58 * k, 0), yaw=yaw):
            arms()
    else:
        arms()
    box((0.4 * k, 0.4 * k, 0.38 * k), L(0, b + 0.84 * k, 0), SKIN, yaw=yaw)
    box((0.44 * k, 0.14 * k, 0.42 * k), L(-0.03 * k, b + 1.08 * k, 0), HAIR[hair % 4], yaw=yaw)

def gable_roof(F, yaw, y0, D, L, H, roof, wall, pitch_deg=45.0, t=0.4, over=0.5, cap=True):
    """A pitched roof over walls D across (X) and L along (Z), H tall, its
    ridge along Z: the gable ends a square beam turned along the ridge (its
    upper half stands over the walls as the end walls' triangles), two slabs
    and a ridge cap (unless `cap` is off). Returns the ridge height."""
    a = math.radians(pitch_deg)
    rise = D / 2 * math.tan(a)
    g = D / math.sqrt(2)
    box((g, g, L - 0.04), F(0, y0 + H, 0), wall, yaw=yaw, roll=math.pi / 4)
    if pitch_deg != 45.0:   # the beam's triangle only fits 45: a steeper roof stands a wall block under it
        box((D * 0.7, rise - D / 2, L - 0.04), F(0, y0 + H + (rise - D / 2) / 2 + D / 4, 0), wall, yaw=yaw)
    w = (D / 2 + over) / math.cos(a)
    for k in (-1, 1):
        cx = k * (w / 2 * math.cos(a) + math.sin(a) * t / 2)
        cy = y0 + H + rise - w / 2 * math.sin(a) + math.cos(a) * t / 2
        box((w, t, L + 2 * over * 0.8), F(cx, cy, 0), roof, yaw=yaw, roll=k * a)
    if cap:
        box((t * 1.3, t * 1.3, L + 2 * over * 0.8 + 0.1), F(0, y0 + H + rise + t * 0.55, 0), roof, yaw=yaw)
    return y0 + H + rise

def window(F, yaw, x, y, z, w=1.3, h=1.3, glass='slate'):
    """A window on a +X wall at x: a white frame standing proud, the glass in it."""
    box((0.14, h + 0.3, w + 0.3), F(x + 0.05, y, z), 'white', yaw=yaw)
    box((0.14, h, w), F(x + 0.11, y, z), glass, yaw=yaw)

def cottage(at, yaw, wall, roof, door=0x339cf2, L=8.0, D=5.5, H=4.2, smoke=False, chimney=1, cap=True):
    """A cottage, its front on +X turned by `yaw`: a steep pitched roof (ridge
    along its length, Z), a chimney at one gable (none at `chimney` 0), a door
    and two windows in white frames standing proud as a car's lamps do."""
    F = local(at[0], at[2], yaw)
    y0 = at[1]
    box((D, H, L), F(0, y0 + H / 2, 0), wall, yaw=yaw)
    ridge = gable_roof(F, yaw, y0, D, L, H, roof, wall, cap=cap)
    cz = chimney * (L / 2 - 1.1)
    if chimney:
        box((1.1, 2.6, 1.1), F(-0.6, ridge - 0.6, cz), 0xb06041, yaw=yaw)
    if smoke:
        marker('anim_smoke', F(-0.6, ridge + 0.8, cz))
    box((0.14, 2.4, 1.5), F(D / 2 + 0.05, 1.2 + y0, 0), 'white', yaw=yaw)
    box((0.14, 2.1, 1.1), F(D / 2 + 0.11, 1.05 + y0, 0), door, yaw=yaw)
    for s in (-1, 1):
        window(F, yaw, D / 2, y0 + H * 0.55, s * L * 0.3)

def washing(at, yaw, n, seed):
    """A garden washing line along Z on two T-posts, chest high, n things
    pegged on it swaying together in the wind about the line."""
    F = local(at[0], at[2], yaw)
    y0 = at[1]
    LH = 2.2
    span = n * 1.25 + 1.0
    for s in (-1, 1):
        box((0.2, LH + 0.15, 0.2), F(0, y0 + (LH + 0.15) / 2, s * span / 2), 0x9a7b55, yaw=yaw)
        box((0.9, 0.16, 0.16), F(0, y0 + LH + 0.07, s * span / 2), 0x9a7b55, yaw=yaw)
    strut(F(0.35, y0 + LH, -span / 2), F(0.35, y0 + LH, span / 2), 0.07, 'white')
    KIND = [(0xff5040, 0.9, 0.8), (0xf8f8fb, 1.0, 1.1), (0x339cf2, 0.7, 1.0), (0xffc044, 0.9, 0.7),
            (0x22c46e, 0.8, 0.9), (0xa259e6, 0.9, 0.8)]
    with animated('anim_sway:a=z:d=20:p=%.1f#%d' % (2.0 + 0.3 * (seed % 3), seed), F(0.35, y0 + LH, 0), yaw=yaw):
        for i in range(n):
            col, w, h = KIND[(i + seed * 2) % len(KIND)]
            z = -span / 2 + 0.75 + i * 1.25
            box((0.08, h, w), F(0.35, y0 + LH - h / 2 + 0.02, z), col, yaw=yaw)

def hedge(F, yaw, y0, a, b, h=1.1, t=0.9):
    """A clipped garden hedge from local (x, z) a to b."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dz)
    # along the hedge in the frame: its yaw there is atan2(dx, dz)
    box((t, h, ln + t), F((a[0] + b[0]) / 2, y0 + h / 2, (a[1] + b[1]) / 2), 0x4f9a48, yaw=yaw + math.atan2(dx, dz))

def round_tree(at, h=5.0, r=2.0, color=0x5f9f4a):
    """A small garden tree: a trunk and one faceted crown."""
    cyl(0.25 * r / 2, h * 0.5, at, 0x7a5a3a, segs=6)
    sphere(r, (at[0], at[1] + h - r, at[2]), color, subdiv=1)

def tent(at, yaw, color, L=2.4, W=1.8, H=1.3, door=0x2a2735, trim=None):
    """A ridge tent, its door end on +X: two pitched sheets, a back wall and
    an open door, dark (or `door`), a `trim` along its ridge if given."""
    F = local(at[0], at[2], yaw)
    y0 = at[1]
    a = math.atan2(H, W / 2)
    w = math.hypot(W / 2, H)
    for k in (-1, 1):
        box((L, 0.1, w), F(0, y0 + H / 2, k * W / 4), color, yaw=yaw, pitch=-k * a)
    box((0.2, H * 0.85, 0.5), F(L / 2 - 0.05, y0 + H * 0.42, 0), door, yaw=yaw)
    if trim:
        box((L + 0.04, 0.1, 0.16), F(0, y0 + H - 0.02, 0), trim, yaw=yaw)

def kennel(at, yaw):
    """A dog's kennel, its door on +X, and the dog sitting at it."""
    F = local(at[0], at[2], yaw)
    y0 = at[1]
    box((1.1, 0.8, 1.0), F(0, y0 + 0.4, 0), 0xd94f3d, yaw=yaw)
    gable_roof(F, yaw, y0, 1.1, 1.0, 0.8, 0x7a5a3a, 0xd94f3d, t=0.12, over=0.12)
    box((0.12, 0.5, 0.4), F(0.56, y0 + 0.27, 0), 0x2a2735, yaw=yaw)
    # the dog: body, sitting haunch, head, ears, tail
    box((0.7, 0.42, 0.34), F(1.0, y0 + 0.3, 0.1), 0xb06041, yaw=yaw)
    box((0.36, 0.36, 0.3), F(1.4, y0 + 0.62, 0.1), 0xb06041, yaw=yaw)
    box((0.2, 0.16, 0.16), F(1.62, y0 + 0.56, 0.1), 0x2a2735, yaw=yaw)
    box((0.3, 0.14, 0.1), F(0.62, y0 + 0.5, 0.1), 0xb06041, yaw=yaw, roll=0.5)

# ---- RIBBON: the village -------------------------------------------------------------
# Ribbon is a village in the hills: cottages up the terraces either side of
# the circuit, each with its own washing out, the church with its spire over
# the green where the maypole's ribbons go round, and the windmill on the hill
# at the south end turning. The spire and the sails are the tall things, as
# they are in a real village; everything else is a cottage's size.

@piece(REAL)
def cottage_row():
    # Three cottages along a lane (their fronts +X, to the road), each with a
    # back garden hedged off from the next: washing out either side, the
    # vegetable bed in the middle one, a shed. One chimney smokes. They stand
    # on the flat by the road, which a deck's cap holds level.
    WALL = (0xf8f8fb, 0xfde4c7, 0xf8f8fb)
    ROOF = (0xcf534f, 0xd9b054, 0x4f5260)
    DOOR = (0x339cf2, 0x22c46e, 0xff5040)
    for i, z in enumerate((-11.0, 0.0, 11.0)):
        x = (0.0, 0.8, -0.4)[i]
        cottage((x, 0, z), 0.0, WALL[i], ROOF[i], DOOR[i], smoke=(i == 1), chimney=(1, -1, 1)[i])
        if i != 1:
            washing((x - 8.5, 0, z), 0.0, 4 + i // 2, i)
    F = local(0, 0, 0)
    for z in (-16.5, -5.5, 5.5, 16.5):
        hedge(F, 0.0, 0.0, (-3.0, z), (-14.0, z))
    hedge(F, 0.0, 0.0, (-14.0, -16.5), (-14.0, 16.5))
    # the shed under its lean-to roof, the vegetable bed
    box((2.6, 2.2, 2.0), (-12.0, 1.1, -13.5), 0x9a7b55)
    box((3.0, 0.24, 2.4), (-12.0, 2.35, -13.5), 0x4f5260, roll=0.2)
    box((5.0, 0.3, 6.0), (-7.0, 0.15, 0.0), 0x7a5a3a)
    for k in range(2):
        box((0.6, 0.5, 5.4), (-8.0 + k * 2.0, 0.45, 0.0), 0x61cb8b)
    join_still('cottages')

def street_side(look):
    # One side of the village street the long diagonal runs down, the road on
    # +X, all of it at the ROAD's level: the land beside low road stands a
    # little under the deck (the renderer's verge) and the 9 u ground grid
    # cannot rise to the kerb, so the street brings its own ground. The
    # pavement is the road's (a `street` in the track's land turns its kerb
    # into a kerbstone and paving out to the margin a piece keeps from the
    # deck); this takes over at its edge, a step under it (PH over the
    # piece's foot, which stands about that far under the deck's top, so
    # where the road's curve brings the paving over the lawn, the paving
    # wins): the front lawns OPEN
    # (a path to each door, a flower bed, a shrub: no fence, hedge or wall),
    # four cottages standing on that lawn with their doors on the street. The
    # lawn ends where the houses do, a step down to the back gardens, and each
    # end ramps down. Laid twice along each side, right at yaw 0 and left at
    # yaw 180, each turned to its own chord of the road's curve, a lane's
    # width apart, one of each (village_street_b's cottages wear the
    # colours in another order). Plain blocks (no chamfer), no ridge caps, half the
    # chimneys: the merged bake draws a triangle's corners apiece, and the
    # street is seen from far down the lap.
    GARDEN, D, PH = 4.0, 5.5, 1.08                # build units (x4 at REAL)
    PITCH, N = 11.5, 4
    WALL = (0xf8f8fb, 0xfde4c7, 0xd0e8ff, 0xfde4c7)
    ROOF = (0xcf534f, 0x4f5260, 0xd9b054, 0xb06041)
    DOOR = (0x339cf2, 0xff5040, 0x22c46e, 0x339cf2)
    LEN = (8.0, 7.0, 8.5, 7.5)
    FLOWERS = ((0xff5040, 0xffc044), (0xa878e8, 0xff5040), (0xffc044, 0xf8f8fb), (0xff5040, 0xa878e8))
    run = PITCH * N
    back = GARDEN + D                                                         # the lawn's depth
    box((back, PH, run), (-back / 2, PH / 2, 0.0), 0x6cae55)                  # the lawn
    for e in (-1, 1):                                                          # the ends ramp down
        z0, z1 = e * run / 2, e * (run / 2 + 4 * PH)
        ground_poly([(0, PH, z0), (-back, PH, z0), (-back, 0, z1), (0, 0, z1)], [(0, 1, 2, 3)], 0x6cae55)
    for i in range(N):
        z = -run / 2 + PITCH * (i + 0.5)
        q = (i * 3 + look) % 4
        cottage((-GARDEN - D / 2, PH, z), 0.0, WALL[q], ROOF[(i + 2 * look) % 4], DOOR[(i + 1 + look) % 4], L=LEN[q],
                D=D, H=4.2 - 0.2 * ((i + look) % 2), smoke=(i == 2 and not look), chimney=(0, -1, 0, 1)[(i + look) % 4],
                cap=False)
        gx = -GARDEN / 2
        box((GARDEN, 0.12, 1.4), (gx, PH + 0.06, z), 'cream')                 # the path to the door
        sd = (1, -1)[(i + look) % 2]                                          # a flower bed beside it
        box((1.6, 0.4, 2.8), (gx + 0.4, PH + 0.2, z + sd * 2.7), 0x7a5a3a)
        for k, col in enumerate(FLOWERS[(i + look) % 4]):
            box((0.8, 0.7, 0.8), (gx + 0.4, PH + 0.75, z + sd * (2.1 + 1.2 * k)), col)
        sphere(1.1, (gx - 0.4, PH + 0.75, z - sd * 3.0), 0x4f9a48, scale=(1.0, 0.8, 1.0))   # a shrub
    for o in bpy.context.scene.objects:                  # plain blocks: no chamfer (see above)
        o['chamfer'] = 0
    join_still('street')

@piece(REAL)
def village_street():
    street_side(0)

@piece(REAL)
def village_street_b():
    street_side(1)

@piece(REAL)
def village_church():
    # The church: nave along Z under a slate roof, the tower at its -Z end
    # carrying the spire (the tallest thing in the village, about six cars),
    # a porch on the road side (+X), the clock; yews and headstones in the
    # churchyard behind. On the green before it the maypole stands, its
    # ribbons loose in the breeze, the children round it between dances.
    s0 = set_ground('village-church')(0.0, 0.0) - 0.3
    STONE, SLATE = 0xfde4c7, 0x4f5260
    F = local(0, 0, 0)
    D, L, H = 8.0, 16.0, 6.5
    box((D, H, L), (0, H / 2, 0), STONE)
    gable_roof(F, 0.0, 0.0, D, L, H, SLATE, STONE, pitch_deg=45.0)
    TZ = -L / 2 - 2.6
    T = 5.6
    box((T, 14.0, T), (0, 7.0, TZ), STONE)
    for sx in (-1, 1):                                    # the tower's corner pinnacles
        for sz in (-1, 1):
            box((0.8, 1.4, 0.8), (sx * (T / 2 - 0.4), 14.7, TZ + sz * (T / 2 - 0.4)), STONE)
    cyl(2.5, 11.5, (0, 14.0, TZ), SLATE, r2=0.12, segs=8)             # the spire
    cyl(1.3, 0.2, (T / 2, 10.4, TZ), 'white', segs=12, axis='across')  # the clock
    box((0.12, 0.9, 0.16), (T / 2 + 0.22, 10.7, TZ), 0x2a2735)
    box((0.12, 0.16, 0.7), (T / 2 + 0.22, 10.4, TZ + 0.3), 0x2a2735)
    box((0.14, 3.0, 1.6), (T / 2 + 0.06, 1.5, TZ), 0x7a5a3a)              # the tower door
    for z in (-5.0, -1.0, 5.0):                                           # tall windows
        window(F, 0.0, D / 2, 3.6, z, w=1.0, h=2.8, glass=0x6794d9)
    # the porch on the road side
    PF = local(D / 2 + 1.5, 2.6, 0.0)
    box((3.0, 3.0, 3.0), PF(0, 1.5, 0), STONE)
    box((0.14, 2.3, 1.3), PF(1.55, 1.15, 0), 0x7a5a3a)
    box((3.4, 0.4, 3.8), PF(-0.1, 3.2, 0), SLATE)
    # the churchyard behind: two yews, headstones
    for z in (-6.0, 6.0):                                 # (a yew's dark green snapped to slate: a second spire)
        cyl(0.4, 1.4, (-D / 2 - 4.5, 0, z), 0x7a5a3a, segs=6)
        cyl(2.4, 6.0, (-D / 2 - 4.5, 1.2, z), 0x4f9a48, r2=0.5, segs=8)
    for k in range(4):
        box((0.25, 1.0, 0.7), (-D / 2 - 2.0 - (k % 2) * 2.2, 0.5, -2.0 + (k // 2) * 3.0), 'grey')
    # the green: a bench each side, the maypole
    MX = D / 2 + 9.5
    for z in (-6.0, 6.0):
        bench((MX + 3.5, 0, z), yaw=-math.pi / 2)
    box((0.35, 9.0, 0.35), (MX, 4.5, 0), 'white')
    cyl(0.5, 0.5, (MX, 9.0, 0), 0xff5040, segs=8)
    COLS = (0xff5040, 0x339cf2, 0xffc044, 0x22c46e, 0xa259e6, 0xf8f8fb, 0x339cf2, 0xff5040)
    # The dance has stopped for a breather: the children stand round the
    # pole and its ribbons hang loose off the crown, each lifting and
    # falling in the breeze on its own. The wind moves, nobody does: a ring
    # of children carried round the pole read as figures gliding over the
    # grass, skipping or not.
    cyl(0.75, 0.5, (MX, 8.2, 0), 0xffc044, segs=8)
    for k in range(6):
        a = k * 2 * math.pi / 6 + 0.5
        ax, az = MX + 0.6 * math.cos(a), 0.6 * math.sin(a)
        with animated('anim_sway:a=z:d=14:p=%.2f#rib%d' % (2.4 + 0.25 * k, k), (ax, 8.3, az), yaw=-a):
            strut((ax, 8.3, az), (MX + 2.2 * math.cos(a), 2.6, 2.2 * math.sin(a)), 0.12, COLS[(k + 3) % 8])
    for k in range(6):
        a = k * 2 * math.pi / 6
        person((MX + 4.4 * math.cos(a), 0, 4.4 * math.sin(a)), math.pi - a, COLS[k], k=0.7, hair=k, arm=0.25 * (k % 2))
    for o in bpy.context.scene.objects:          # onto its level ground
        o.location.z += s0
    ANIMS[:] = [(n, (x, y + s0, z), yaw, p, t) for n, (x, y, z), yaw, p, t in ANIMS]
    join_still('church')

@piece(REAL)
def windmill():
    # The village's tower mill: a whitewashed tower tapering to a red cap,
    # its stage round it, door and windows on the road side (+X), and four
    # sails turning about the windshaft, face on to the road. Real size:
    # about five cars to the cap, the sails sweeping to seven.
    H = 15.0
    cyl(4.2, H, (0, 0, 0), 'white', r2=3.0, segs=8, yaw=math.pi / 8)   # a face, not an edge, to the road
    cyl(3.4, 2.8, (0, H, 0), 0xcf534f, r2=1.6, segs=8)
    box((1.6, 0.8, 4.4), (0.4, H + 1.2, 0), 0xcf534f)
    cyl(4.9, 0.35, (0, 3.4, 0), 0x9a7b55, segs=8, yaw=math.pi / 8)      # the stage, under the sails' sweep
    box((0.3, 2.6, 1.6), (3.92, 1.3, 0), 0x7a5a3a)                       # the door
    for y in (8.5, 12.0):
        r = (4.2 - 1.2 * y / H) * math.cos(math.pi / 8)
        window(local(0, 0, 0), 0.0, r - 0.1, y, 0, w=0.9, h=1.1)
    for k in (-1, 1):                                                    # sacks by the door
        box((0.8, 0.9, 0.7), (5.0, 0.45, k * 1.6), 0xfde4c7)
    HY, HX = H + 1.3, 3.2
    with animated('anim_spin:a=x:w=0.7', (HX + 0.9, HY, 0)):
        cyl(0.7, 2.6, (HX - 1.0, HY, 0), 0x2a2735, segs=8, axis='across')
        for k in range(4):
            a = k * math.pi / 2 + math.pi / 4
            dy, dz = math.sin(a), math.cos(a)
            strut((HX + 0.9, HY, 0), (HX + 0.9, HY + dy * 11.5, dz * 11.5), 0.4, 0x7a5a3a)
            # the sail on the leading side of its stock: a white board, its laths
            py, pz = math.cos(a), -math.sin(a)
            cy, cz = HY + dy * 7.2 + py * 1.15, dz * 7.2 + pz * 1.15
            box((0.12, 2.0, 8.4), (HX + 1.05, cy, cz), 'white', pitch=a)
            for j in (-1, 1):
                box((0.14, 0.16, 8.4), (HX + 1.12, cy + py * j * 0.9, cz + pz * j * 0.9), 0x9a7b55, pitch=a)
    join_still('mill')

def strip(sections, color, caps=True):
    """A ridge laid along a run of cross-sections, each a list of (x, y, z)
    corners from one foot over the top to the other: one mesh, its faces
    between consecutive sections, its ends capped. A crop row, a drill."""
    n, m = len(sections), len(sections[0])
    verts = [v for s in sections for v in s]
    sides = [(i * m + j, (i + 1) * m + j, (i + 1) * m + j + 1, i * m + j + 1)
             for i in range(n - 1) for j in range(m - 1)]
    # one winding for every side face: the crest of the first span faces up
    pv = [P(*v) for v in verts]
    a, b, c = pv[sides[m // 2 - 1][0]], pv[sides[m // 2 - 1][1]], pv[sides[m // 2 - 1][2]]
    if (b - a).cross(c - a).z < 0:
        sides = [tuple(reversed(f)) for f in sides]
    faces = sides
    if caps:
        for k, nxt in ((0, 1), (n - 1, n - 2)):
            cap = tuple(k * m + j for j in range(m))
            a, b, c = pv[cap[0]], pv[cap[1]], pv[cap[2]]
            out = sum((pv[k * m + j] - pv[nxt * m + j] for j in range(m)), Vector((0, 0, 0)))
            faces = faces + [cap if (b - a).cross(c - a).dot(out) > 0 else tuple(reversed(cap))]
    me = bpy.data.meshes.new('strip')
    me.from_pydata([tuple(v) for v in pv], [], faces)
    me.update()
    o = bpy.data.objects.new('strip', me)
    bpy.context.scene.collection.objects.link(o)
    o['chamfer'] = 0
    return paint(o, color)

def runs(inside, x, z0, z1, step=1.0):
    """The stretches of the line at x, z0..z1, where inside(x, z) holds."""
    out, start, z = [], None, z0
    while z <= z1:
        if inside(x, z):
            if start is None:
                start = z
        elif start is not None:
            out.append((start, z - step))
            start = None
        z += step
    if start is not None:
        out.append((start, z1))
    return out

def crop_rows(inside, x0, x1, pitch, h, top, color, z0=-200.0, z1=200.0, seg=8.0, end=0.35):
    """Rows of a crop along Z, `pitch` apart over x0..x1, wherever inside(x, z)
    holds: each a ridge `pitch` wide at its foot, `top` wide at its flat crest
    `h` up (a number, or h(x, z) for a crop that swells and dips), cut into
    `seg` lengths so a drape lays it on the land between; its ends slope off to
    `end` of its height over their last 1.5."""
    height = h if callable(h) else (lambda x, z: h)
    x = x0 + pitch / 2
    while x < x1:
        for a, b in runs(inside, x, z0, z1):
            if b - a < 2.0:
                continue
            k = max(1, int(math.ceil((b - a) / seg)))
            zs = [a] + [a + 1.5] + [a + (b - a) * i / k for i in range(1, k)] + [b - 1.5, b]
            zs = sorted(set(round(z, 3) for z in zs if a <= z <= b))
            secs = []
            for z in zs:
                hh = height(x, z) * (end if z in (zs[0], zs[-1]) else 1.0)
                secs.append([(x - pitch / 2, 0.0, z), (x - top / 2, hh, z), (x + top / 2, hh, z), (x + pitch / 2, 0.0, z)])
            strip(secs, color)
        x += pitch

def round_bale(at, yaw=0.0, color='yellow'):
    """A round bale lying on its side, its axis across its local Z."""
    cyl(0.8, 1.3, (at[0], at[1] + 0.8, at[2]), color, segs=10, axis='along', yaw=yaw)

def tractor(at, body=0xcf534f):
    """A little farm tractor facing +X: big rear wheels, small front ones, the
    bonnet ahead, the cab's roof on four posts, an exhaust stack."""
    x, y, z = at
    with plain_parts():
        for s in (-1, 1):
            cyl(0.85, 0.5, (x - 0.9, y + 0.85, z + s * 0.95 - (0.5 if s > 0 else 0)), 0x2a2735, segs=10, axis='along')
            cyl(0.5, 0.36, (x + 1.3, y + 0.5, z + s * 0.75 - (0.36 if s > 0 else 0)), 0x2a2735, segs=8, axis='along')
            cyl(0.42, 0.52, (x - 0.9, y + 0.85, z + s * 1.0 - (0.52 if s > 0 else 0)), 'yellow', segs=8, axis='along')
    box((2.2, 0.8, 1.0), (x + 0.6, y + 1.2, z), body)                  # the bonnet
    box((1.4, 1.2, 1.3), (x - 0.8, y + 1.4, z), body)                   # under the cab
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((0.12, 1.3, 0.12), (x - 0.8 + sx * 0.6, y + 2.6, z + sz * 0.6), 0x2a2735)
    box((1.7, 0.16, 1.6), (x - 0.8, y + 3.3, z), 'white')               # the cab's roof
    box((0.18, 1.0, 0.18), (x + 1.2, y + 2.0, z + 0.3), 0x2a2735)       # the exhaust

def hash01(*v):
    """A repeatable number in [0, 1) from a few numbers (a tree's size, its lean)."""
    return frac(math.sin(sum(x * k for x, k in zip(v, (12.9898, 78.233, 37.719, 4.1414)))) * 43758.5453)

# ---- the lawn's own trees ------------------------------------------------------------
# No kit fir stands on a lawn: every tree of the grass world is built here,
# and each backyard track keeps to ONE family, its scatter (the tree_* pieces
# below, theme.cc backyardTrack) and its set pieces alike, so everything in a
# frame belongs together. Pretzel: faceted broadleaf oaks. Cloverleaf: cherries
# in blossom. Tangle: tall dark alders and the weeping willows. Ribbon: the
# orchard's smooth round-lobed trees and poplars of the same make. Metres
# (a REAL piece's), the foot at y = 0; none is named `pine` (the snowy pine).
def lawn_oak(x, z, k=1.0):
    """Pretzel's oak: a stout trunk under four faceted lobes."""
    cyl(0.7 * k, 7.5 * k, (x, -0.5, z), 0x7a5a3a, r2=0.5 * k, segs=7)
    for (dx, y, dz), r, c in (((0.0, 8.6, 0.0), 3.4, 0x5f9f4a), ((-2.2, 7.6, 1.4), 2.6, 0x6cae55),
                              ((0.6, 7.9, -1.8), 2.4, 0x6cae55), ((-0.8, 10.6, 0.4), 2.4, 0x5f9f4a)):
        sphere(r * k, (x + dx * k, y * k, z + dz * k), c, subdiv=1)

CHERRY_CROWN = (((0.0, 7.2, 0.0), 2.9, 0), ((-2.2, 6.2, 1.3), 2.2, 0), ((1.9, 6.5, -1.6), 2.1, 1),
                ((0.4, 8.8, 0.5), 1.9, 0), ((-0.5, 5.4, -2.3), 1.6, 2))

def lawn_cherry(x, z, k, c, i=0):
    """Cloverleaf's cherry in blossom, `c` 'pink' or 'white': grey-brown bark,
    a forked trunk under four lobes of pale blossom (one of the other shade)
    and a low one in young leaf. `i` turns the crown, so no two in a row are
    one tree."""
    main, other = ('blossom', 'petal') if c == 'pink' else ('petal', 'blossom')
    cyl(0.5 * k, 5.0 * k, (x, -0.5, z), 'bark', r2=0.32 * k, segs=6)
    a = 0.6 + 2.1 * i
    o = cyl(0.3 * k, 3.2 * k, (x, 3.6 * k, z), 'bark', r2=0.14 * k, segs=5, smooth=False)
    tilted(o, math.cos(a) * 0.8, math.sin(a) * 0.8)
    t = 1.3 * i
    ct, st = math.cos(t), math.sin(t)
    for (dx, y, dz), r, kind in CHERRY_CROWN:
        sphere(r * k, (x + (dx * ct + dz * st) * k, y * k, z + (dz * ct - dx * st) * k),
               (main, other, 'leaf')[kind], subdiv=1, yaw=t)['ramp'] = 0.75

def lawn_alder(x, z, k=1.0, turn=0.0):
    """Tangle's alder: tall and narrow, a dark trunk under three faceted
    lobes stood one over another, the valley's dark green (far down the
    swatch's ramp), so a stand of them is a dark wood."""
    cyl(0.5 * k, 8.0 * k, (x, -0.5, z), 0x5a3a2a, r2=0.32 * k, segs=6)
    c, s = math.cos(turn), math.sin(turn)
    for (dx, y, dz), r, sy, row in (((0.0, 7.4, 0.0), 3.3, 1.35, 21), ((0.6, 11.8, -0.4), 2.5, 1.45, 17),
                                    ((-1.6, 5.8, 1.0), 2.5, 1.15, 25)):
        rowed(sphere(r * k, (x + (dx * c + dz * s) * k, y * k, z + (dz * c - dx * s) * k), 0x5f9f4a, subdiv=1,
                     scale=(1.0, sy, 1.0), yaw=turn), row)

def lawn_poplar(x, z, k=1.0):
    """Ribbon's poplar: the tall shape among its orchards, a slim column of
    smooth lobes stepped up a bare trunk, the apple trees' make."""
    cyl(0.4 * k, 5.0 * k, (x, -0.3, z), 0x7a5a3a, r2=0.26 * k, segs=6, stem=True)
    sphere(2.0 * k, (x, 6.6 * k, z), 0x6cae55, subdiv=2, flat=False, scale=(1.0, 1.9, 1.0))
    sphere(1.5 * k, (x + 0.3 * k, 10.6 * k, z - 0.2 * k), 0x5f9f4a, subdiv=1, flat=False, scale=(1.0, 2.0, 1.0))
    sphere(1.2 * k, (x - 0.9 * k, 5.0 * k, z + 0.7 * k), 0x5f9f4a, subdiv=1, flat=False, scale=(1.0, 1.5, 1.0))

# The windmill's field, in the north loop's east side: the wheat standing
# golden, a crop that comes up over the kerb's height, its rows packed close
# and ragged at their ends where the harvest has not reached; the far end
# already cut, the stubble with round bales on it and the tractor going round
# them; two poplars left standing in it by its east edge. A
# rectangle kept 2.4 u inside every kerb (the largest that fits, scratch
# geometry): a piece's box holds the verge band down under it (bandHold), so
# one piece over the whole loop stood the road on a step. It DRAPES, lying on
# the lawn as drawn. Metres, the rows along Z; +X toward the loop's east bend.
def round_rect(hx, hz, r):
    """Whether (x, z) lies in a rectangle +-hx by +-hz with corners rounded r."""
    def inside(x, z):
        dx, dz = max(0.0, abs(x) - (hx - r)), max(0.0, abs(z) - (hz - r))
        return abs(x) <= hx and abs(z) <= hz and dx * dx + dz * dz <= r * r
    return inside

@piece(REAL)
def field_wheat():
    HX, HZ, R, CUT = 18.5, 44.0, 12.0, 20.0
    field = round_rect(HX, HZ, R)
    PINES = ((13.5, -14.0, 17.0), (13.0, 4.0, 14.5))         # standing in the crop by its east edge
    def standing(x, z):                    # each row's ends ragged by up to 3.5
        return (field(x, z) and -HZ + 3.5 * hash01(x, 1) < z < CUT - 3.5 * hash01(x, 2)
                and all(math.hypot(x - px, z - pz) > 5.0 for px, pz, _ in PINES))
    def cut(x, z):
        return field(x, z) and z > CUT + 3.0
    def h(x, z):
        return 2.1 * (1.0 + 0.12 * math.sin(z * 0.19 + x * 0.07) + 0.07 * math.sin(z * 0.53 - x * 0.31))
    pts = []
    for k in range(14):
        a = -k * 2 * math.pi / 14
        pts.append((11.0 * math.cos(a), 33.0 + 6.0 * math.sin(a)))
    for k, (x, z) in enumerate(pts):
        marker('path_drapetractor_%d' % k, (x, 0.0, z))
    with animated('anim_path:c=drapetractor:p=46:f=1', (pts[0][0], 0.0, pts[0][1])):
        tractor((pts[0][0], 0.0, pts[0][1]))

    def still():
        before = set(bpy.context.scene.objects)
        crop_rows(standing, -HX, HX, 2.4, h, 2.05, 'yellow', z0=-HZ, z1=HZ, seg=5.0, end=0.75)
        crop_rows(cut, -HX, HX, 2.4, 0.3, 1.6, 'yellow', z0=-HZ, z1=HZ)
        for o in bpy.context.scene.objects:   # the crop golden, not run down the ramp to orange
            if o not in before:
                o['ramp'] = 0.25
        for k, (x, z) in enumerate(((-15.0, 28.0), (15.0, 40.0), (-2.0, 33.0), (8.0, 27.0), (-9.0, 41.0))):
            round_bale((x, 0.2, z), yaw=0.6 * k, color=('yellow', 'tan')[k % 2])
        for px, pz, k in PINES:
            lawn_poplar(px, pz, k / 16.0)
    draped('wheat', still)

# The orchard round the outside of the south loop, at the foot of the south
# hill, where a racer going round the loop looks: blocks of apple trees, three
# rows of three set out square, each block laid along the road where it stands
# (tracks.js), so the rows turn with the bend. The trees round-crowned, two or
# three lobes each, a quarter bigger or smaller than one another and leaning a
# little; apples red on most, yellow on a few. Three kinds of block, turned
# either way round as they are laid: a second with a ladder up a tree and
# crates of picked apples, and a third, at the band's end, standing two of the
# village's poplars among its apple trees, so the loop keeps its tall shapes. A block,
# not one piece round the loop: a piece's box holds the verge band down under
# it (bandHold), so one over the whole loop stood the road on a step. It
# DRAPES: the trees stand on the land as drawn. The lite builds (the Android
# TV's) keep each tree to one coarser lobe and no apples.
def apple_tree(x, z, seed, lite, apples=6, top=True):
    k = 0.8 + 0.4 * hash01(x, z, seed)                     # a quarter either way
    lx, lz = 0.1 * (hash01(x, z, seed, 1) - 0.5), 0.1 * (hash01(z, x, seed, 2) - 0.5)
    trunk = cyl(0.38 * k, 2.4 * k, (x, -0.3, z), 0x7a5a3a, r2=0.28 * k, segs=6, stem=True)
    tilted(trunk, math.atan(lz), math.atan(lx))
    cx, cz, cy = x + lx * 3.4 * k, z + lz * 3.4 * k, 3.7 * k
    a = hash01(x, z, seed, 3) * 6.28
    # smooth-shaded, so even the small lobes' few faces read round
    sphere(1.9 * k, (cx, cy, cz), 0x6cae55, subdiv=1 if lite else 2, flat=False, scale=(1.0, 0.84, 1.0))
    if lite:
        return
    # the crown in lobes round the middle one, each on a bough of its own
    # showing under it, so the tree is branched, not a ball on a stick
    for j, (da, r, dy, c) in enumerate(((0.0, 1.5, -0.55, 0x5f9f4a), (2.2, 1.35, 0.35, 0x6cae55), (4.1, 1.25, -0.25, 0x5f9f4a))):
        b = a + da
        px, pz = cx + 1.55 * k * math.cos(b), cz + 1.55 * k * math.sin(b)
        sphere(r * k, (px, cy + dy * k, pz), c, subdiv=2, flat=False, scale=(1.0, 0.86, 1.0))
        if j < 2:
            with plain_parts():
                strut((x, 1.9 * k, z), (px, cy + (dy - 0.6) * k, pz), 0.3 * k, 0x7a5a3a)
    if top:
        sphere(1.1 * k, (cx - 0.2 * k, cy + 1.3 * k, cz + 0.2 * k), 0x6cae55, subdiv=2, flat=False, scale=(1.0, 0.8, 1.0))
    # apples a racer can count, out on the crown's skin
    fruit = 0xffc044 if hash01(x, z, seed, 5) > 0.85 else 0xcf534f
    with plain_parts():
        for j in range(apples):
            c = a + 0.6 + j * 6.28 / apples
            rr = (2.0, 2.5, 2.15)[j % 3] * k
            box((0.56 * k, 0.56 * k, 0.56 * k), (cx + rr * math.cos(c), cy + (-0.75, 0.35, -0.1)[j % 3] * k, cz + rr * math.sin(c)),
                fruit, yaw=c)

ORCH_SP = 8.4   # metres between trees (2.1 u)

def orchard_trees(seed, lite, pines=False):
    for i in range(3):
        for j in range(3):
            x, z = (i - 1) * ORCH_SP, (j - 1) * ORCH_SP
            if pines and i == 2 and j != 1:                     # the outer row's corners: poplars
                lawn_poplar(x, z, 1.0 + 0.12 * j / 2)
            else:
                apple_tree(x, z, seed, lite)

def ladder_and_crates():
    # a ladder up the middle tree on the road side, crates of apples by it
    for s in (-1, 1):
        strut((2.4, 0.0, s * 0.35), (0.9, 3.6, s * 0.35), 0.12, 0x9a7b55)
    for j in range(5):
        box((0.12, 0.1, 0.7), (2.4 - 1.5 * (j + 0.5) / 5, 3.6 * (j + 0.5) / 5, 0.0), 0x9a7b55)
    for j in range(3):
        box((0.9, 0.6, 0.7), (4.2, 0.3 + 0.6 * (j // 2), -2.0 + 1.0 * (j % 2)), 0x9a7b55)
        box((0.7, 0.2, 0.5), (4.2, 0.62 + 0.6 * (j // 2), -2.0 + 1.0 * (j % 2)), 0xcf534f)

def orchard(seed, lite, pines=False, ladder=False):
    def still():
        orchard_trees(seed, lite, pines)
        if ladder and not lite:
            ladder_and_crates()
    draped('orchard', still)

@piece(REAL)
def orchard_block():
    orchard(0, False)

@piece(REAL)
def orchard_block_b():
    orchard(1, False, ladder=True)

@piece(REAL)
def orchard_block_end():
    orchard(2, False, pines=True)

@piece(REAL)
def orchard_block_lite():
    orchard(0, True)

@piece(REAL)
def orchard_block_b_lite():
    orchard(1, True, ladder=True)

@piece(REAL)
def orchard_block_end_lite():
    orchard(2, True, pines=True)

# The hay made on the bank past the village street's end (tracks.js `land`):
# round bales in two straight rows along the slope where the baler dropped
# them, all one straw yellow and lying one way, and the tractor going slowly
# round the far row with its trailer, two bales already on it; two of the
# village's poplars left standing at the back. Scattered at odd angles in two
# colours the bales read as speckle from the road; in rows they read as a
# field. It DRAPES on the bank as drawn. Front (+X) to the road, metres; on
# the left at yaw 180.
def bale_trailer(at):
    """A flatbed farm trailer facing +X, two round bales on it."""
    x, y, z = at
    with plain_parts():
        for s in (-1, 1):
            cyl(0.5, 0.35, (x, y + 0.5, z + s * 0.95 - (0.35 if s > 0 else 0)), 0x2a2735, segs=8, axis='along')
        box((3.0, 0.2, 1.9), (x, y + 0.95, z), 0x9a7b55)
        box((0.9, 0.12, 0.12), (x + 1.9, y + 0.8, z), 0x4f5260)                   # the drawbar
        for dx in (-0.75, 0.75):
            cyl(0.7, 1.4, (x + dx, y + 1.75, z - 0.7), 'yellow', segs=10, axis='along')

@piece(REAL)
def hay_meadow():
    ROWS, Z0, Z1, STEP = (12.0, 3.0), -15.0, 15.0, 5.0
    pts = []                                      # the tractor's lane: round the far row
    for k in range(18):
        a = -k * 2 * math.pi / 18
        pts.append((2.5 + 5.0 * math.cos(a), 19.0 * math.sin(a)))
    for k, (x, z) in enumerate(pts):
        marker('path_drapetractor_%d' % k, (x, 0.0, z))
    with animated('anim_path:c=drapetractor:p=70:f=1#tractor', (pts[0][0], 0.0, pts[0][1])):
        tractor((pts[0][0], 0.0, pts[0][1]))
    with animated('anim_path:c=drapetractor:p=70:o=0.955:f=1#trailer', (pts[0][0], 0.0, pts[0][1])):
        bale_trailer((pts[0][0], 0.0, pts[0][1]))
    def still():
        before = set(bpy.context.scene.objects)
        for x in ROWS:
            z = Z0
            while z <= Z1 + 1e-6:
                cyl(1.15, 1.6, (x, 1.15, z - 0.8), 'yellow', segs=10, axis='along')
                z += STEP
        for o in bpy.context.scene.objects:      # straw yellow, not run down the ramp to orange
            if o not in before:
                o['ramp'] = 0.25
        lawn_poplar(-8.0, -11.0, 1.0)
        lawn_poplar(-9.5, 9.0, 0.9)
    draped('hay', still)

# The dairy farm on the lawn inside the west bend, where the bend's driver
# looks across it: the red barn with its silo, the herd grazing out in front
# of it, side on to the road and a body length or more apart so each reads as
# a cow, each lifting its head now and then (Crag's cows, the same gesture),
# the water trough, churns waiting at the barn door. World units (a cow is a
# car long): barn, silo and herd read as one scene, where a cow alone is a
# speck. Front (+X) to the road; on the left, yaw 180. It DRAPES, the heads
# too (`drape`), on the lawn as drawn.
def red_barn(x, z):
    RED, ROOF = 0xcf534f, 0x4f5260
    F = local(x, z, 0.0)
    box((1.5, 0.95, 2.4), (x, 0.475, z), RED)
    gable_roof(F, 0.0, 0.0, 1.5, 2.4, 0.95, ROOF, RED, t=0.08, over=0.12)
    box((0.04, 0.72, 0.84), (x + 0.77, 0.36, z), 'white')                  # the doors' frame
    box((0.04, 0.64, 0.76), (x + 0.79, 0.34, z), 0x7a5a3a)
    with plain_parts():
        strut((x + 0.82, 0.04, z - 0.36), (x + 0.82, 0.64, z + 0.36), 0.05, 'white')
        strut((x + 0.82, 0.04, z + 0.36), (x + 0.82, 0.64, z - 0.36), 0.05, 'white')
        box((0.04, 0.24, 0.3), (x + 0.77, 1.15, z), 'white')               # the loft door
        box((0.04, 0.18, 0.22), (x + 0.79, 1.15, z), 0x2a2735)
    cyl(0.4, 1.9, (x - 0.2, 0, z - 1.75), 'white', segs=10)                 # the silo
    sphere(0.42, (x - 0.2, 1.9, z - 1.75), 0x6794d9, scale=(1.0, 0.7, 1.0))

@piece(1.0)
def cow_farm():
    def still():
        red_barn(-1.6, 0.4)
        box((0.4, 0.3, 1.4), (0.9, 0.15, -3.0), 0x9a7b55)                   # the trough
        box((0.32, 0.04, 1.3), (0.9, 0.3, -3.0), 0x62d3c8)
        with plain_parts():
            for k in range(3):                                              # churns at the door
                cyl(0.09, 0.26, (-0.6, 0, 0.1 + 0.22 * k), 'white', segs=8)
            hay_bale((-0.4, 0, 1.6), yaw=0.3)
        H = math.pi / 2
        HERD = ((1.6, -1.6, H, 0x8a5a3c), (1.5, 0.6, -H, 0xf8f8fb), (1.6, 2.8, H, 0x2a2735),
                (0.2, -0.6, -H, 0xf8f8fb), (0.3, 1.7, H + 0.3, 0x5a3a28), (-0.4, 3.5, -H, 0x2a2735))
        for k, (x, z, yaw, coat) in enumerate(HERD):
            cow((x, 0, z), yaw=yaw, coat=coat, life='anim_drape+sway:a=z:d=30:p=%.1f:r=0.75#c%d' % (6.6 + 0.9 * k, k))
    draped('farm', still)

# A flock on the meadow at the foot of the north-east hill, round the outside
# of the north loop's bend, where a racer going round it looks: the shepherd's
# hut on its iron wheels, an old oak, the sheep grazing, each lifting its head
# now and then; and more of the flock on the lawn under the flyover, round
# their trough and hay rack. World units; front (+X) to the road, on the left
# at yaw 180.
def sheep(at, yaw, life):
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def p(dx, dy, dz):
        return (x + dx * c + dz * s, y + dy, z - dx * s + dz * c)
    with plain_parts():
        for lx in (-0.14, 0.13):
            box((0.07, 0.18, 0.2), p(lx, 0.09, 0), 0x2a2735, yaw=yaw)
    box((0.48, 0.28, 0.34), p(0, 0.31, 0), 0xf8f8fb, yaw=yaw)              # the fleece
    box((0.4, 0.08, 0.28), p(0, 0.48, 0), 0xf8f8fb, yaw=yaw)
    with animated(life, p(0.22, 0.36, 0), yaw):
        box((0.16, 0.15, 0.13), p(0.3, 0.28, 0), 0x2a2735, yaw=yaw, roll=-0.6)

def flock(spots, tag):
    for k, (x, z, yaw) in enumerate(spots):
        sheep((x, 0, z), yaw, 'anim_drape+sway:a=z:d=28:p=%.1f:r=0.72#%s%d' % (5.8 + 0.7 * k, tag, k))

@piece(1.0)
def sheep_meadow():
    def still():
        # the shepherd's hut, its door and steps on +X
        HX, HZ = -1.6, 1.2
        with plain_parts():
            for sx in (-1, 1):
                for sz in (-1, 1):
                    cyl(0.16, 0.06, (HX + sx * 0.34, 0.16, HZ + sz * 0.42 - (0.06 if sz > 0 else 0)), 0x2a2735, segs=8, axis='along')
        box((0.8, 0.5, 1.1), (HX, 0.55, HZ), 0x22c46e)
        cyl(0.42, 1.16, (HX, 0.8, HZ - 0.58), 0xcf534f, segs=10, axis='along')
        box((0.04, 0.36, 0.26), (HX + 0.41, 0.56, HZ), 0xcf534f)
        box((0.24, 0.2, 0.26), (HX + 0.55, 0.1, HZ), 0x9a7b55)
        box((0.04, 0.16, 0.18), (HX + 0.41, 0.62, HZ - 0.36), 'sky')
        # the old oak beside it
        cyl(0.16, 1.0, (HX - 0.4, 0, HZ - 1.7), 0x7a5a3a, r2=0.11, segs=7, stem=True)
        sphere(0.95, (HX - 0.4, 1.6, HZ - 1.7), 0x5f9f4a, subdiv=1, scale=(1.0, 0.8, 1.0))
        sphere(0.6, (HX - 0.9, 1.35, HZ - 1.2), 0x6cae55, subdiv=1)
        flock(((0.6, -1.2, 0.4), (1.4, -0.3, 2.6), (0.9, 0.9, -0.7), (2.0, 1.6, 1.2), (1.8, -1.9, -2.4),
               (0.2, 2.3, 3.1), (2.6, 0.2, 0.9), (-0.2, -2.6, 1.8), (1.2, 3.0, -1.5)), 's')
    draped('meadow', still)

@piece(1.0)
def sheep_flock():
    def still():
        # their trough and the hay rack, a post-and-slat crib with hay in it
        box((0.3, 0.24, 1.1), (-0.6, 0.12, -0.4), 0x9a7b55)
        box((0.22, 0.04, 1.0), (-0.6, 0.24, -0.4), 0x62d3c8)
        for sz in (-1, 1):
            box((0.08, 0.6, 0.08), (-0.9, 0.3, 1.3 + sz * 0.45), 0x7a5a3a)
        box((0.5, 0.36, 1.0), (-0.9, 0.5, 1.3), 'yellow')
        box((0.1, 0.06, 1.1), (-0.9, 0.7, 1.3), 0x7a5a3a)
        flock(((0.5, -1.6, 0.6), (1.3, -0.4, 2.4), (0.2, 0.5, -0.9), (1.6, 1.4, 1.5), (0.4, 2.2, 2.9),
               (-0.3, 0.2, 1.9), (1.0, -2.6, -2.0)), 'f')
    draped('flock', still)

# The village fete on the green beside the start straight, its right, on race
# day: the helter-skelter at the near end, the tallest thing on the green and
# striped like a stick of rock, a child going round and down it on a mat (up
# again inside the tower); the bouncy castle; the tea tent; the carousel
# turning slowly, a child riding; the stalls under their striped awnings; the
# coconut shy; bunting strung between them. Real size (the tea tent is a
# cottage and a half long, the helter-skelter as tall as the church's nave
# roof), all of it within a few units of the kerb, nothing on the verge
# itself. Front (+X) to the road, metres, on the right at yaw 0; the line is
# at z -22.
def horse(at, yaw, coat, saddle):
    """A carousel horse facing +X turned by `yaw`, its hooves at `at`'s level."""
    F = local(at[0], at[2], yaw)
    y = at[1]
    box((1.5, 0.6, 0.5), F(0, y + 1.0, 0), coat, yaw=yaw)
    box((0.5, 0.75, 0.36), F(0.75, y + 1.45, 0), coat, yaw=yaw, roll=-0.5)
    box((0.6, 0.32, 0.34), F(1.05, y + 1.75, 0), coat, yaw=yaw)
    box((0.5, 0.14, 0.54), F(-0.05, y + 1.36, 0), saddle, yaw=yaw)
    with plain_parts():
        for sx, kick in ((-0.55, 0.5), (0.55, -0.5)):
            for sz in (-0.16, 0.16):
                box((0.16, 0.6, 0.16), F(sx + 0.1 * kick, y + 0.5, sz), coat, yaw=yaw, roll=kick)

def stall(at, yaw, colors, goods):
    """A market stall, its counter on +X under a striped awning."""
    F = local(at[0], at[2], yaw)
    y = at[1]
    box((1.4, 1.0, 3.2), F(0.5, y + 0.5, 0), 0xfde4c7, yaw=yaw)            # the counter
    box((0.2, 2.6, 3.2), F(-0.6, y + 1.3, 0), colors[1], yaw=yaw)           # the back
    for sz in (-1, 1):
        box((0.14, 2.6, 0.14), F(1.1, y + 1.3, sz * 1.5), 0x9a7b55, yaw=yaw)
    with plain_parts():
        for k in range(6):                                                  # the striped awning
            box((2.4, 0.12, 3.6 / 6), F(0.35, y + 2.75, -1.8 + 3.6 * (k + 0.5) / 6), colors[k % 2], yaw=yaw, roll=-0.25)
        for k in range(4 if goods else 0):
            box((0.4, 0.3, 0.4), F(0.6, y + 1.15, -1.1 + 0.73 * k), goods[k % len(goods)], yaw=yaw)

def bunting(a, b, colors, n=None):
    """A string of pennants between two points, sagging a little."""
    L = math.dist(a, b)
    n = n or max(3, int(L / 0.9))
    pts = sag(a, b, 0.25 + 0.02 * L, n + 1)
    with plain_parts():
        for i in range(n):
            p, q = pts[i], pts[i + 1]
            strut(p, q, 0.06, 'white')
            m = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2)
            poly([p, q, (m[0], m[1] - 0.55, m[2])], [(0, 1, 2)], colors[i % len(colors)])

def fete(lite):
    # lite (the Android TV's build): what a racer at speed does not read off
    # the green goes (the bunting, the stalls' goods, the tea tables, the
    # coconut shy, the stallholders), and the slide is cut coarser
    RED, WHITE, YELLOW, BLUE = 0xcf534f, 0xf8f8fb, 0xffc044, 0x339cf2
    # ---- the helter-skelter, at the near end
    HX, HZ, TR, TH = 8.0, -38.0, 2.0, 10.0
    for k in range(8):                                             # the tower, banded
        cyl(TR + 0.15 - 0.04 * k, TH / 8, (HX, k * TH / 8, HZ), (RED, WHITE)[k % 2], r2=TR + 0.11 - 0.04 * (k + 1), segs=8)
    cyl(TR + 0.5, 0.3, (HX, TH, HZ), BLUE, segs=8)                 # the top platform's rim
    cyl(TR + 0.4, 3.2, (HX, TH + 0.3, HZ), RED, r2=0.1, segs=8)     # the cap
    flagpole((HX, TH + 3.4, HZ), 1.6, YELLOW, w=1.0, fh=0.6, wave='anim_sway:a=y:d=20:p=2.4#hs')
    box((0.2, 1.8, 1.0), (HX + TR - 0.1, TH - 1.0, HZ), 0x2a2735)  # the door at the top
    box((0.2, 1.8, 1.0), (HX + TR + 0.05, 0.9, HZ), 0x2a2735)      # and at the foot
    # the slide: two and a half turns down from the door, a chute with a rim
    R0, TURNS, Y0, Y1 = TR + 1.6, 2.5, TH - 0.6, 0.5
    N = 24 if lite else 40
    helix = []
    for i in range(N + 1):
        t = i / N
        a = t * TURNS * 2 * math.pi
        helix.append((HX + R0 * math.cos(a), Y0 + (Y1 - Y0) * t, HZ + R0 * math.sin(a)))
    with plain_parts():
        for i in range(N):
            p, q = helix[i], helix[i + 1]
            strut(p, q, 1.5, YELLOW)
            mx, mz = (p[0] + q[0]) / 2 - HX, (p[2] + q[2]) / 2 - HZ
            r = math.hypot(mx, mz)
            ox, oz = mx / r * 0.85, mz / r * 0.85
            strut((p[0] + ox, p[1] + 0.35, p[2] + oz), (q[0] + ox, q[1] + 0.35, q[2] + oz), 0.2, RED)
            if i % (3 if lite else 5) == 2:
                box((0.2, p[1], 0.2), (p[0] + ox, p[1] / 2, p[2] + oz), WHITE)
    # the child going down on a mat, and back up inside the tower
    for i in range(0, N + 1, 2):
        x, y, z = helix[i]
        marker('path_hskid_%d' % (i // 2), (x, y + 0.2, z))
    up = N // 2 + 1
    for j, y in enumerate((0.8, TH * 0.5, TH - 0.6)):
        marker('path_hskid_%d' % (up + j), (HX, y, HZ))
    x, y, z = helix[0]
    with animated('anim_path:c=hskid:p=14:f=1', (x, y + 0.2, z)):
        box((1.2, 0.12, 0.8), (x, y + 0.26, z), 0x9a7b55)
        person((x, y + 0.36, z), 0.0, BLUE, k=0.65, hair=2, sit=True, arm=0.4)
    # ---- the bouncy castle, a child bouncing in it
    BX, BZ = 8.0, -21.0
    # every form blown up: a pillow of a floor, walls of fat tubes stood side
    # by side with round tops, drum turrets under domes, a roll over the door
    box((7.0, 1.1, 7.0), (BX, 0.55, BZ), RED)['round'] = 0.5
    NT, TR = (3, 1.0) if lite else (5, 0.62)       # the lite build's walls in three fatter tubes
    for i in range(NT):
        t = -2.4 + 4.8 * i / (NT - 1)
        for (wx, wz, c) in ((-3.0, t, YELLOW), (t, -3.0, BLUE), (t, 3.0, BLUE)):
            cyl(TR, 2.0, (BX + wx, 1.0, BZ + wz), (c, RED)[i % 2] if c == BLUE else c, segs=8 if lite else 10, smooth=True)
            sphere(TR, (BX + wx, 3.0, BZ + wz), (c, RED)[i % 2] if c == BLUE else c, subdiv=2, flat=False)
    for sx in (-1, 1):
        for sz in (-1, 1):
            c = (BLUE, RED)[(sx + sz) % 4 == 0]
            cyl(1.05, 3.6, (BX + sx * 3.0, 0.9, BZ + sz * 3.0), c, segs=12, smooth=True)
            sphere(1.05, (BX + sx * 3.0, 4.5, BZ + sz * 3.0), c, subdiv=2, flat=False)
            sphere(1.15, (BX + sx * 3.0, 5.0, BZ + sz * 3.0), YELLOW, subdiv=2, flat=False, scale=(1.0, 0.75, 1.0))
            sphere(0.4, (BX + sx * 3.0, 5.95, BZ + sz * 3.0), YELLOW, subdiv=1, flat=False)
    cyl(0.55, 6.0, (BX + 3.0, 4.2, BZ - 3.0), YELLOW, segs=10, axis='along', smooth=True)    # the roll over the door
    box((1.8, 0.5, 4.2), (BX + 4.2, 0.25, BZ), BLUE)['round'] = 0.25                          # the step in
    # a child in it, arms up: still, since a body moves only riding something
    # (set_motion.h), and the castle does not
    person((BX, 0.8, BZ), 0.0, 0x22c46e, k=0.65, hair=3, arm=2.6)
    # ---- the tea tent, along the green behind
    MX, MZ, MW, ML, MH = -3.0, -6.0, 6.0, 12.0, 2.8
    box((MW, MH, ML), (MX, MH / 2, MZ), WHITE)
    gable_roof(local(MX, MZ, 0.0), 0.0, 0.0, MW, ML, MH, RED, WHITE, pitch_deg=35.0, t=0.2, over=0.4, cap=False)
    for k in range(3):
        box((0.14, 2.2, 1.6), (MX + MW / 2 + 0.05, 1.1, MZ - 4.0 + 4.0 * k), 0x2a2735)  # the open doorways
    for sz in (-1, 1):
        cyl(0.12, 6.0, (MX, 0, MZ + sz * (ML / 2 + 0.3)), WHITE, segs=6)
    # tables out front, a parasol over one, someone at tea
    for k, z in enumerate(() if lite else (MZ - 3.0, MZ + 3.0)):
        box((1.6, 0.1, 1.0), (MX + MW / 2 + 3.0, 0.9, z), WHITE)
        for s in (-1, 1):
            box((0.12, 0.85, 0.12), (MX + MW / 2 + 3.0 + s * 0.6, 0.43, z), 0x9a7b55)
    if not lite:
        umbrella((MX + MW / 2 + 3.0, 0, MZ + 3.0), 1.6, 2.6, (RED, WHITE), gores=8)
        person((MX + MW / 2 + 3.0, 0.5, MZ - 3.7), math.pi / 2, 0xa878e8, hair=1, sit=True, arm=0.3)
        for z in (MZ - 3.7, MZ + 3.7):
            box((0.5, 0.5, 0.5), (MX + MW / 2 + 3.0, 0.25, z), 0x9a7b55)
    # ---- the carousel, turning
    CX, CZ, CR = 8.0, 10.0, 4.0
    cyl(CR + 0.3, 0.4, (CX, 0, CZ), 0x4f5260, segs=12)
    with animated('anim_spin:a=y:w=0.45', (CX, 0.4, CZ)):
        cyl(CR, 0.3, (CX, 0.4, CZ), RED, segs=12)
        cyl(0.7, 5.8, (CX, 0.7, CZ), YELLOW, segs=8)
        for k in range(12):                                      # the canopy, in gores
            a0, a1 = k / 12 * 2 * math.pi, (k + 1) / 12 * 2 * math.pi
            top = (CX, 6.6, CZ)
            r0 = (CX + math.cos(a0) * (CR + 0.4), 5.0, CZ + math.sin(a0) * (CR + 0.4))
            r1 = (CX + math.cos(a1) * (CR + 0.4), 5.0, CZ + math.sin(a1) * (CR + 0.4))
            poly([top, r0, r1], [(0, 1, 2)], (RED, WHITE)[k % 2])
            box((0.12, 0.7, 2 * (CR + 0.4) * math.sin(math.pi / 12)), (CX + math.cos((a0 + a1) / 2) * (CR + 0.36), 4.75,
                CZ + math.sin((a0 + a1) / 2) * (CR + 0.42)), (BLUE, YELLOW)[k % 2], yaw=-(a0 + a1) / 2)
        COATS = (WHITE, 0x9a7b55, WHITE, 0x2a2735, WHITE, 0xb06041)
        for k in range(6):
            a = k * 2 * math.pi / 6
            px, pz = CX + 2.9 * math.cos(a), CZ + 2.9 * math.sin(a)
            box((0.12, 5.0, 0.12), (px, 3.2, pz), YELLOW)
            horse((px, 0.7, pz), -a - math.pi / 2, COATS[k], (RED, BLUE, YELLOW)[k % 3])
            if k == 1:
                person((px, 2.1, pz), -a - math.pi / 2, 0x22c46e, k=0.65, hair=3, sit=True, arm=0.3)
    # ---- the stalls, under their striped awnings, someone at each
    for k, (cols, goods, shirt) in enumerate((((RED, WHITE), (YELLOW, 0xff7e44, 0xcf534f), 0xa878e8),
                                             ((BLUE, WHITE), (0x61cb8b, WHITE, YELLOW), 0xffc044),
                                             ((0x22c46e, WHITE), (0xa878e8, 0xff7e44), 0x339cf2))):
        z = 22.0 + 6.0 * k
        stall((4.0, 0, z), 0.0, cols, () if lite else goods)
        if not lite:
            person((6.4, 0, z + 0.4 - 0.8 * k), math.pi, shirt, k=(1.0, 0.7, 0.7)[k], hair=k)
    # the coconut shy at the far end: its frame, the coconuts on posts
    SX, SZ = 6.0, 43.0
    for sz in (-1, 1):
        box((0.2, 3.0, 0.2), (SX, 1.5, SZ + sz * 2.5), 0x9a7b55)
    box((0.2, 0.2, 5.2), (SX, 3.0, SZ), 0x9a7b55)
    for x, z in ((1.0, 18.0), (1.0, 47.0)):                         # the bunting's poles
        cyl(0.12, 4.6, (x, 0, z), WHITE, segs=6)
    if not lite:
        coconuts_and_bunting(SX, SZ, HX, HZ, TH, MX, MZ, ML)
    join_still('fete')

def coconuts_and_bunting(SX, SZ, HX, HZ, TH, MX, MZ, ML):
    RED, WHITE, YELLOW, BLUE = 0xcf534f, 0xf8f8fb, 0xffc044, 0x339cf2
    with plain_parts():
        for k in range(5):
            box((0.12, 0.6, 1.0), (SX - 0.2, 2.6, SZ - 2.0 + k), (RED, WHITE)[k % 2])
            box((0.1, 1.0, 0.1), (SX + 0.8, 0.5, SZ - 2.0 + k), 0x9a7b55)
            sphere(0.24, (SX + 0.8, 1.15, SZ - 2.0 + k), 0x7a5a3a)
    # bunting: off the helter-skelter's top, along the tea tent, behind the stalls
    COLS = (RED, BLUE, YELLOW, WHITE, 0x22c46e)
    bunting((HX, TH + 0.2, HZ), (MX, 6.0, MZ - ML / 2 - 0.3), COLS)
    bunting((MX, 6.0, MZ - ML / 2 - 0.3), (MX, 6.0, MZ + ML / 2 + 0.3), COLS)
    bunting((MX, 6.0, MZ + ML / 2 + 0.3), (1.0, 4.5, 18.0), COLS)
    bunting((1.0, 4.5, 18.0), (1.0, 4.5, 47.0), COLS)

@piece(REAL)
def village_fete():
    fete(False)

@piece(REAL)
def village_fete_lite():
    fete(True)

# ---- PRETZEL: the treehouse -----------------------------------------------------------
# Pretzel's old oak on its hill, a tree about six cars tall, with the
# children's den in it: a platform round the trunk on legs, a red hut on it
# a car wide, a ladder, a rope ladder, a flag, the tyre swinging from a bough
# with a child in it. At its foot their tent, the trampoline with a child
# bouncing, and the dog at its kennel. It grew on its knoll (SET_GROUND): built
# from the summit, then lifted onto it, the trunk sunk in and everything at its
# foot standing on the slope.

@piece(REAL)
def treehouse():
    # On the flat by the bend's outside, straight ahead down the avenue: on a
    # knoll that close to the road the deck's cap held the land down under
    # it, and its legs hung.
    H = lambda x, z: 0.0
    s0 = H(0.0, 0.0)
    G = lambda x, z: H(x, z) - s0
    BARK, WOOD = 0x7a5a3a, 0xb08a5a
    cyl(1.4, 15.0, (0, -2.0, 0), BARK, r2=0.9, segs=10)
    for a, r, h in ((1.6, 0.6, 5.0), (3.4, 0.55, 4.6), (5.0, 0.5, 4.4)):  # boughs away from the hut
        o = cyl(r, h, (0, 9.0, 0), BARK, r2=0.25, segs=7, smooth=False)
        tilted(o, math.cos(a) * 0.9, math.sin(a) * 0.9)
    for c, r in (((0, 18.0, 0), 6.2), ((-4.8, 16.0, 3.0), 4.6), ((4.2, 16.6, -3.4), 4.4),
                 ((1.0, 21.2, 2.4), 4.2), ((-2.0, 19.5, -3.6), 3.8)):
        sphere(r, c, 0x5f9f4a if r > 4.5 else 0x6cae55, subdiv=1)
    # the platform on four legs, its rails
    PY = 4.4
    box((7.6, 0.35, 6.6), (0.6, PY, 0), WOOD)
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = 0.6 + sx * 3.6, sz * 3.1
            box((0.3, PY - G(x, z) + 0.2, 0.3), (x, (PY + G(x, z)) / 2, z), WOOD)
    for sz in (-1, 1):
        box((7.6, 0.18, 0.18), (0.6, PY + 1.0, sz * 3.2), WOOD)
        for x in (-3.0, -1.0, 1.0):
            box((0.16, 1.0, 0.16), (x, PY + 0.5, sz * 3.2), WOOD)
    box((0.18, 0.18, 6.6), (-3.1, PY + 1.0, 0), WOOD)
    # the hut on the platform's road side (+X), clear of the trunk
    HF = local(2.9, 0.0, 0.0)
    box((3.0, 2.5, 4.0), HF(0, PY + 1.42, 0), 0xd94f3d)
    gable_roof(HF, 0.0, PY + 0.17, 3.0, 4.0, 2.5, 0x7a5a3a, 0xd94f3d, t=0.25, over=0.3)
    box((0.12, 1.7, 0.9), HF(1.56, PY + 1.05, -0.8), 0x5a3a2a)
    window(HF, 0.0, 1.5, PY + 1.6, 0.9, w=0.8, h=0.7, glass=0x8ecae6)
    flagpole((-3.1, PY + 1.0, -3.1), 2.6, 0x22c46e, w=1.4, fh=0.8, pole=WOOD, wave='anim_sway:a=z:d=22:p=1.5')
    # the ladder up the front, its foot out on the lawn
    for s in (-1, 1):
        strut((3.0 + s * 0.4, G(3.0, 5.4) - 0.1, 5.4), (3.0 + s * 0.4, PY, 3.3), 0.16, WOOD)
    for i in range(6):
        t = (i + 0.8) / 6.6
        y0 = G(3.0, 5.4)
        box((0.9, 0.12, 0.14), (3.0, y0 + (PY - y0) * t, 5.4 - 2.1 * t), WOOD)
    # the rope ladder off the back
    for s in (-1, 1):
        strut((-2.6, PY, s * 0.35 - 1.0), (-2.6, G(-2.6, -1.0) + 0.3, s * 0.35 - 1.0), 0.07, 0x9a7b55)
    for i in range(5):
        box((0.12, 0.1, 0.8), (-2.6, G(-2.6, -1.0) + 0.6 + i * 0.75, -1.0), 0x9a7b55)
    # the tyre swing from its own bough, a child sitting in it
    BX, BZ = -6.0, -5.0
    strut((0.0, 9.6, -0.2), (BX, 10.6, BZ), 0.7, BARK)
    gy = G(BX + 0.3, BZ + 0.3)
    with animated('anim_sway:a=x:d=24:p=2.8', (BX + 0.3, 10.3, BZ + 0.3)):
        strut((BX + 0.3, 10.4, BZ + 0.3), (BX + 0.3, gy + 1.3, BZ + 0.3), 0.08, 0x9a7b55)
        torus(0.55, 0.2, (BX + 0.3, gy + 0.95, BZ + 0.3), 0x2a2735, segs=12, axis='across')
        person((BX + 0.3, gy + 0.85, BZ + 0.3), 0.0, 0xffc044, k=0.65, hair=1, sit=True)
    # a child up on the platform, looking out
    person((1.6, PY + 0.17, -2.6), 0.4, 0x339cf2, k=0.7, hair=0)
    # the den at its foot: the tent, the trampoline with a child bouncing, the dog
    tent((7.5, G(7.5, -5.0), -5.0), 0.5, 0xffc044)
    TX, TZ = -1.0, 9.5
    ty = G(TX, TZ)
    cyl(1.9, 0.12, (TX, ty + 0.8, TZ), 0x2a2735, segs=12)
    torus(1.9, 0.12, (TX, ty + 0.9, TZ), 0x339cf2, segs=12)
    for k in range(4):
        a = k * math.pi / 2 + 0.4
        box((0.16, 1.9, 0.16), (TX + 1.8 * math.cos(a), ty - 0.05, TZ + 1.8 * math.sin(a)), 0x555b66)   # legs bedded in the slope
    with animated('anim_bob:h=0.16:p=0.8:b=1', (TX, ty + 0.92, TZ)):    # about her own height, landing on the mat
        person((TX, ty + 0.92, TZ), 0.6, 0xff5040, k=0.7, hair=2, arm=2.6)
    kennel((-4.5, G(-4.5, 6.0), 6.0), 1.2)
    for o in bpy.context.scene.objects:          # onto the summit
        o.location.z += s0
    ANIMS[:] = [(n, (x, y + s0, z), yaw, p, t) for n, (x, y, z), yaw, p, t in ANIMS]
    join_still('oak')

@piece(REAL)
def swing_oak():
    # Pretzel: another of the garden's old oaks out by a bend, the tall thing
    # a racer on the lawn's road sees over the kerb: a tyre swing from its low
    # bough with a child riding it, a bike dropped at the trunk. The same tree
    # as the treehouse's, a little smaller, so the summer reaches round the
    # lap without a second den.
    BARK = 0x7a5a3a
    cyl(1.2, 12.0, (0, -0.5, 0), BARK, r2=0.8, segs=9)
    for a, r, h in ((2.2, 0.5, 4.4), (4.4, 0.45, 4.0)):
        o = cyl(r, h, (0, 7.5, 0), BARK, r2=0.22, segs=7, smooth=False)
        tilted(o, math.cos(a) * 0.9, math.sin(a) * 0.9)
    for c, r in (((0, 14.5, 0), 5.2), ((-4.0, 13.0, 2.6), 3.9), ((3.6, 13.4, -2.8), 3.8),
                 ((0.8, 17.6, 2.0), 3.6), ((-1.8, 16.4, -3.0), 3.2)):
        sphere(r, c, 0x5f9f4a if r > 4.0 else 0x6cae55, subdiv=1)
    # the swing's bough out toward the road (+X), the tyre on its rope
    BX, BZ = 5.0, 1.0
    strut((0.0, 8.0, 0.2), (BX, 8.9, BZ), 0.6, BARK)
    with animated('anim_sway:a=x:d=24:p=2.6', (BX - 0.3, 8.6, BZ)):
        strut((BX - 0.3, 8.7, BZ), (BX - 0.3, 1.3, BZ), 0.08, 0x9a7b55)
        torus(0.55, 0.2, (BX - 0.3, 0.95, BZ), 0x2a2735, segs=12, axis='across')
        person((BX - 0.3, 0.85, BZ), 0.0, 0x22c46e, k=0.65, hair=2, sit=True)
    # the bike dropped on the grass at the trunk
    for z in (-0.9, 0.9):
        torus(0.55, 0.1, (2.2, 0.12, -2.0 + z), 0x2a2735, segs=10)
    box((0.12, 0.12, 1.8), (2.2, 0.2, -2.0), 0xff5040)
    join_still('oak')

@piece(REAL)
def avenue_oaks():
    # One side of an avenue down a straight: five matched oaks, the garden's
    # own broadleaf (the swing oak's tree, a size smaller and without its
    # swing), 20 apart along Z (5 u in the world), the trunks by x = 0 with
    # the road off +X. Each crown leans back off the road, so its edge stays
    # clear of the deck's margin. Laid either side of the road, right at yaw 0,
    # left at yaw 180. The scatter is kept off the avenue's verge by a `clear`
    # landform in the track's `land`, not by this footprint.
    BARK, STEP, N = 0x7a5a3a, 20.0, 5
    for i in range(N):
        z = STEP * (i - (N - 1) / 2)
        cyl(0.95, 10.0, (-0.6, -0.5, z), BARK, r2=0.65, segs=7)
        for a, r, h in ((2.4, 0.4, 3.6), (4.0, 0.36, 3.2)):           # two boughs, back from the road
            o = cyl(r, h, (-0.6, 6.0, z), BARK, r2=0.18, segs=6, smooth=False)
            tilted(o, math.cos(a) * 0.85, math.sin(a) * 0.85)
        for (x, y, dz), r in (((-1.6, 11.8, 0.0), 4.4), ((-4.4, 10.6, 2.2), 3.3), ((0.6, 10.9, -2.0), 3.0),
                              ((-2.0, 14.4, 1.0), 3.0)):
            sphere(r, (x, y, z + dz * (1, -1)[i % 2]), 0x5f9f4a if r > 4.0 else 0x6cae55, subdiv=1)
    join_still('avenue')

@piece(REAL)
def football_pitch():
    # Pretzel: the village pitch laid along the road, its lines painted on
    # the lawn, little goals at the ends, and a kickabout on. Nobody runs: a
    # body sliding over the grass reads uncanny however it is posed. Three
    # children stand in a triangle in the far half, each just having
    # struck the ball on to the next, and the BALL is what moves, lofted from
    # foot to foot round the triangle. The keepers wait on their lines, arms
    # going up now and then, a child on the touchline cheering (gestures).
    PW, PL, T = 26.0, 42.0, 0.36
    W = 'white'
    n = 8                                         # the turf, mown across in eight stripes
    for q in range(n):
        z0, z1 = -PL / 2 - 3.0 + (PL + 6.0) * q / n, -PL / 2 - 3.0 + (PL + 6.0) * (q + 1) / n
        rowed(ground_poly([(-PW / 2 - 3.0, 0.2, z0), (PW / 2 + 3.0, 0.2, z0), (PW / 2 + 3.0, 0.2, z1),
                           (-PW / 2 - 3.0, 0.2, z1)], [(0, 3, 2, 1)], 'leaf'), (22, 29)[q % 2])
    def line(x, z, w, l, yaw=0.0):
        box((w, 0.26, l), (x, 0.2, z), W, yaw=yaw)
    for s in (-1, 1):
        line(s * PW / 2, 0, T, PL + T)
        line(0, s * PL / 2, PW, T)
        line(0, s * (PL / 2 - 5.5), 14.0, T)                     # the penalty boxes
        for x in (-7.0, 7.0):
            line(x, s * (PL / 2 - 2.75), T, 5.5)
    line(0, 0, PW, T)
    for k in range(16):                                          # the centre circle
        a = (k + 0.5) * 2 * math.pi / 16
        line(4.5 * math.cos(a), 4.5 * math.sin(a), T, 2 * math.pi * 4.5 / 16 + 0.15, yaw=-a)
    # the goals, mouths in toward the middle: a frame and an open net of cords
    GW, GH, GD, NET = 5.0, 2.0, 1.5, 0xd0e8ff
    for s in (-1, 1):
        z0 = s * PL / 2
        for x in (-GW / 2, GW / 2):
            box((0.2, GH, 0.2), (x, GH / 2, z0), 'white')
            box((0.12, 0.12, GD), (x, 0.06, z0 + s * GD / 2), 'white')
            strut((x, GH, z0), (x, 0.06, z0 + s * GD), 0.12, 'white')
        box((GW + 0.2, 0.2, 0.2), (0, GH, z0), 'white')
        box((GW, 0.12, 0.12), (0, 0.06, z0 + s * GD), 'white')
        for k in range(1, 5):
            x = -GW / 2 + GW * k / 5
            strut((x, GH, z0), (x, 0.06, z0 + s * GD), 0.07, NET)
        for k in (1, 2):
            t = k / 3
            box((GW, 0.07, 0.07), (0, GH * (1 - t), z0 + s * GD * t), NET)
    # the keepers on their lines, arms out ready, going up now and then
    for s, c, hair, p in ((-1, 0x22c46e, 1, 4.6), (1, 0xa259e6, 3, 5.3)):
        person((0, 0, s * (PL / 2 - 1.0)), s * math.pi / 2, c, k=0.72, hair=hair, arm=0.9,
               gesture='anim_sway:a=z:d=110:p=%.1f:r=0.65#keep%d' % (p, s + 1))
    # the passing triangle: each child faces the next, the right foot through
    TRI = [(6.0, -10.0, 0xff5040), (7.0, 2.0, 0x339cf2), (-2.0, -4.0, 0xff5040)]
    feet = []
    for i, (x, z, c) in enumerate(TRI):
        nx, nz, _ = TRI[(i + 1) % 3]
        d = math.hypot(nx - x, nz - z)
        ux, uz = (nx - x) / d, (nz - z) / d
        person((x, 0, z), math.atan2(-uz, ux), c, k=0.72, hair=i, arm=0.5, kick=0.8)
        feet.append((x + 0.55 * ux, z + 0.55 * uz))
    # two more standing off, watching the ball
    for i, (x, z, c) in enumerate(((-6.0, 7.0, 0x339cf2), (2.5, 11.0, 0xff5040))):
        person((x, 0, z), math.atan2(-(-4.0 - z), 3.0 - x), c, k=0.72, hair=i + 2)
    # the ball's round: lofted from each foot, landing a stride short of the
    # next and rolling in to it (a closed path, the ball steady along it).
    # A real ball's size at the toy world's chunkiness (about 1.5x): a ball
    # half a child's height read as a beach ball, and a block that small
    # reads as a box, so it is a smooth one.
    R, LOFT, ROLL = 0.18, 1.6, 1.2
    pts = []
    for i in range(3):
        (x0, z0), (x1, z1) = feet[i], feet[(i + 1) % 3]
        d = math.hypot(x1 - x0, z1 - z0)
        lx, lz = x1 - (x1 - x0) * ROLL / d, z1 - (z1 - z0) * ROLL / d
        for j in range(8):
            u = j / 8
            pts.append((x0 + (lx - x0) * u, R + 4 * LOFT * u * (1 - u), z0 + (lz - z0) * u))
        pts.append((lx, R, lz))
    for k, at in enumerate(pts):
        marker('path_ball_%d' % k, at)
    with animated('anim_path:c=ball:p=6:f=0', pts[0]):
        sphere(R, pts[0], 'white', flat=False)
    # a child on the touchline cheering them on
    person((-PW / 2 - 1.6, 0, 9.0), 0.0, 0xffc044, k=0.68, hair=2, arm=0.2,
           gesture='anim_sway:a=z:d=150:p=3.8:r=0.7#cheer')
    # mums and dads on a bench on the far touchline (+X; the road runs along
    # the -X one)
    PZ = 12.0
    bench((PW / 2 + 2.5, 0, PZ - 3.0), yaw=-math.pi / 2)
    bench((PW / 2 + 2.5, 0, PZ + 3.0), yaw=-math.pi / 2)
    person((PW / 2 + 2.6, 0.5, PZ - 3.0), math.pi, 0xa259e6, hair=1, sit=True)
    person((PW / 2 + 2.6, 0.5, PZ + 3.3), math.pi, 0xffc044, hair=3, sit=True)
    # the club's pavilion they sit in front of, under its veranda, facing the
    # pitch across it from the road: white boards under a red roof, the club
    # flag over the ridge. A real one's size (two cars long); it is what
    # stands up off the lawn, so it is what says pitch from a car whose kerb
    # hides the lines, and from the far side it stands behind the game, not
    # in front of it.
    # Its frame is turned half round (its front to -X, the pitch), and every
    # part is turned with it: a roof slab's roll only matches its side of the
    # ridge in the frame it was built for, or the roof opens like a book.
    D, L, H = 4.4, 10.0, 3.4
    PY = math.pi
    PF = local(PW / 2 + 3.2 + D / 2, PZ, PY)
    box((D, H, L), PF(0, H / 2, 0), 'white', yaw=PY)
    ridge = gable_roof(PF, PY, 0.0, D, L, H, 0xcf534f, 'white')
    box((1.8, 0.2, L), PF(D / 2 + 0.9, H - 0.4, 0), 0x9a7b55, yaw=PY)     # the veranda roof
    for z in (-L / 2 + 0.3, 0.0, L / 2 - 0.3):
        box((0.2, H - 0.4, 0.2), PF(D / 2 + 1.7, (H - 0.4) / 2, z), 0x9a7b55, yaw=PY)
    box((0.14, 2.1, 1.2), PF(D / 2 + 0.06, 1.05, 0), 0x339cf2, yaw=PY)
    for z in (-3.0, 3.0):
        window(PF, PY, D / 2, 2.0, z, w=1.4, h=1.0)
    flagpole(PF(0, ridge - 0.3, 0), 4.2, 0x339cf2, w=1.6, fh=0.9, pole='white',
             wave='anim_sway:a=z:d=22:p=1.6#club')
    # match-day bunting down the road's touchline on tall white posts, and a
    # flag at each corner: the kerb hides the lines, so these say pitch
    BX, BH = -PW / 2 - 1.6, 5.2
    zs = [-PL / 2 - 1.0 + (PL + 2.0) * k / 4 for k in range(5)]
    for z in zs:
        box((0.26, BH, 0.26), (BX, BH / 2, z), 'white')
    for z0, z1 in zip(zs, zs[1:]):
        bunting((BX, BH - 0.15, z0), (BX, BH - 0.15, z1), (0xff5040, 0xffc044, 0x339cf2, 0x22c46e, 'white'), n=9)
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = sx * PW / 2, sz * PL / 2
            box((0.12, 1.8, 0.12), (x, 0.9, z), 'white')
            with plain_parts():
                poly([(x, 1.8, z), (x, 1.3, z), (x, 1.55, z - sz * 0.7)], [(0, 1, 2)], 0xff5040)
    join_still('pitch')

@piece(REAL)
def den_camp():
    # Pretzel: the children's camp on the lawn by the road where it comes off
    # the diagonal's top: three tents round a fire with its smoke going up,
    # the children on logs round it, their flag on a pole, a rope swing from
    # the old tree behind. On the flat at the road's level (it stood up a
    # bank once, above the frame).
    for k, (a, c) in enumerate(((0.5, 0xff5040), (2.4, 0x339cf2), (4.3, 0x22c46e))):
        tent((4.2 * math.cos(a), 0, 4.2 * math.sin(a)), math.pi - a, c)
    for k in range(6):                                   # the fire's ring of stones
        a = k * math.pi / 3
        box((0.5, 0.35, 0.5), (0.9 * math.cos(a), 0.17, 0.9 * math.sin(a)), 'grey', yaw=a)
    for a in (0.3, 1.9):
        box((1.4, 0.3, 0.3), (0, 0.25, 0), 0x7a5a3a, yaw=a)
    box((0.6, 0.7, 0.6), (0, 0.55, 0), 0xff7e44, yaw=0.4)
    box((0.35, 0.5, 0.35), (0.1, 0.95, 0.05), 0xffc044, yaw=0.9)
    marker('anim_smoke', (0, 1.3, 0))
    for k, (a, c) in enumerate(((1.45, 0xffc044), (3.35, 0xa259e6), (5.6, 0xf8f8fb))):
        x, z = 2.2 * math.cos(a), 2.2 * math.sin(a)
        box((0.5, 0.4, 1.4), (x, 0.2, z), 0x7a5a3a, yaw=-a)
        person((x, 0.4, z), math.pi - a, c, k=0.66, hair=k, sit=True, arm=0.5)
    flagpole((-2.6, 0, -4.6), 3.4, 0xff5040, w=1.2, fh=0.7, pole=0x9a7b55, wave='anim_sway:a=z:d=22:p=1.4')
    TX, TZ = -6.5, 1.5                                   # the tree and its rope swing
    cyl(0.7, 6.5, (TX, 0, TZ), 0x7a5a3a, r2=0.45, segs=7)
    sphere(3.2, (TX, 8.2, TZ), 0x5f9f4a, subdiv=1)
    strut((TX, 5.4, TZ), (TX + 3.0, 6.0, TZ), 0.4, 0x7a5a3a)
    with animated('anim_sway:a=z:d=26:p=2.6', (TX + 2.6, 5.9, TZ)):
        strut((TX + 2.6, 5.9, TZ), (TX + 2.6, 0.9, TZ), 0.08, 0x9a7b55)
        box((0.5, 0.1, 0.7), (TX + 2.6, 0.85, TZ), 0x9a7b55)
        person((TX + 2.5, 0.9, TZ), 0.0, 0x339cf2, k=0.64, hair=2, sit=True, arm=1.3)
    join_still('camp')

# ---- TANGLE: the mill stream ------------------------------------------------------------
# Tangle's stream rises in the north loop, runs under the S-bend's bridge
# and the first bridge and over the north lawn to the mill pond on the west,
# ahead of the grid, where the watermill's wheel turns in the race. The
# stream is laid reach by reach (set-stream-reach, each placed along its
# stretch, their tapered ends overlapping); the mill is the hero. Water is a
# flat sheet on the lawn: from the road, eye height over the grass, it is a
# line of blue beside the kerb, so each reach brings a willow on its bank, the tall
# thing that says stream. The water is the kit's sky swatch at the foot of its
# ramp, and the pond it opens into (a `pond` landform the renderer draws,
# TtpRenderer::buildPonds) is painted the same blue: one water.
WATER, MUD = 0x8ecae6, 0xb08a5a
STREAM_W, REACH = 4.2, 88.0   # its half width; a reach's length between its end circles

@piece(REAL)
def stream_reach():
    # One reach of the stream, a steady width with a round end each side:
    # laid end to end, each reach's end circle on the next one's, the water
    # joins round any bend (same height, same colour, so where two lie over
    # each other nothing shows). REACH between the two circles' centres; a
    # mud margin, a few stones and reeds. ONE part, one draw wherever it is,
    # and it DRAPES: the water lies on the lawn as the renderer draws it, up
    # the ground raised under a deck as well, never sunk under it.
    W, M = STREAM_W, 1.2
    zc = REACH / 2
    def ribbon(w, y, color, cuts):
        pts = []
        for t in range(7):                                  # the +Z cap, from its tip
            a = (6 - t) * math.pi / 12
            pts.append((zc + w * math.sin(a), w * math.cos(a)))
        for i in range(1, 10):
            pts.append((zc - REACH * i / 10, w))
        for t in range(7):                                  # the -Z cap, to its tip
            a = t * math.pi / 12
            pts.append((-zc - w * math.sin(a), w * math.cos(a)))
        # Both ribbons are cut at the water's edges and down the middle, so
        # where the drawn ground kinks under a reach the water rides it at
        # the very points the mud does and stays on top (the mud's one flat
        # span from margin to margin rose over the water on a cross slope).
        fr = [f / w for f in cuts]
        n = len(fr)
        verts, faces = [], []
        for i, (z, h) in enumerate(pts):
            verts += [(h * f, y, z) for f in fr]
            if i:
                for j in range(n - 1):
                    faces.append((n * (i - 1) + j, n * i + j, n * i + j + 1, n * (i - 1) + j + 1))
        ground_poly(verts, faces, color)
    ribbon(W + M, 0.12, MUD, (W + M, W, 0.0, -W, -(W + M)))
    ribbon(W, 0.28, WATER, (W, 0.0, -W))
    for i, (x, z, r) in enumerate(((4.4, -30.0, 0.9), (-4.6, -10.0, 0.8), (4.8, 14.0, 1.0), (-0.4, 2.6, 0.7))):
        box((r * 1.3, 0.6 * r, r), (x, 0.3 * r, z), ('grey', 'lavender')[i % 2], yaw=i * 0.9)
    for k, (x, z) in enumerate(((5.6, -20.0), (-5.6, 26.0))):
        for j in range(3):
            a = j * 1.7 + k
            box((0.18, 1.6 - 0.2 * j, 0.18), (x + 0.4 * math.cos(a), 0.8 - 0.1 * j, z + 0.4 * math.sin(a)),
                (0x4f9a48, 0x61cb8b, 0x9a7b55, 0x4f9a48)[j], yaw=a)
    # a willow on the -X bank a quarter of the way along, hanging over the
    # water: the tall thing that says stream from the road on the lawn,
    # where the water itself is a line beside the kerb. Turning a reach
    # half round puts it on the other bank at the other end.
    willow((-W - 3.4, 0, -REACH / 4))
    join_still('drape_reach')

def willow(at):
    """A weeping willow by the water, about as tall as a garden oak (three
    cars): a short trunk, a low round crown and the streamers of its hanging
    branches, a ragged fringe with the trunk showing between them, down to a
    car's height off the ground (one solid curtain read as a green drum)."""
    x, y, z = at
    cyl(0.8, 8.0, (x, y, z), 0x7a5a3a, r2=0.5, segs=7)
    sphere(4.6, (x, y + 9.6, z), 0x6cae55, subdiv=1, scale=(1.0, 0.62, 1.0))
    with plain_parts():
        N = 12
        for k in range(N):                      # each a streamer narrowing to its tip, flared out
            a = (k + 0.5) * 2 * math.pi / N
            h = (5.8, 6.8, 5.1, 6.3)[k % 4]
            o = cyl(0.0, h, (x + 4.8 * math.cos(a), y + 9.9 - h, z + 4.8 * math.sin(a)),
                    (0x61cb8b, 0x6cae55)[k % 2], r2=1.15, segs=3, yaw=a + math.pi / 3)
            tilted(o, -0.14 * math.sin(a), -0.14 * math.cos(a))

def duck(at, color=0xf8f8fb):
    """A duck on the water facing +X: body, tail, head, bill (twice life size)."""
    x, y, z = at
    box((0.9, 0.38, 0.5), (x, y + 0.19, z), color)
    box((0.3, 0.3, 0.36), (x - 0.5, y + 0.3, z), color, roll=0.5)
    box((0.3, 0.42, 0.3), (x + 0.36, y + 0.55, z), 0x22c46e if color != 0xf8f8fb else color)
    box((0.26, 0.1, 0.18), (x + 0.6, y + 0.62, z), 0xff7e44)

@piece(REAL)
def watermill():
    # The mill on its pond: a stone mill house (front +X, to the road) under
    # a red tile roof, the wheel on its road side turning in the race that
    # runs past it into the pond; ducks going round the pond, a weeping
    # willow over the water, someone fishing off the bank. Real size: the
    # house is two cars long, the wheel nearly two across.
    STONE, TILE = 0xfde4c7, 0xcf534f
    PX, PZ, PR = -1.0, -20.0, 13.0                    # the pond, upstream (-Z) of the house
    cyl(PR + 1.4, 0.14, (PX, 0, PZ), MUD, segs=20)
    cyl(PR, 0.3, (PX, 0, PZ), WATER, segs=20)
    # the race: from +Z past the wheel into the pond's +X side
    RX = 6.6
    # A broad mill pool against the house's wall, out past the wheel toward
    # the road, so the wheel stands IN water a racer sees in front of it (a
    # narrow race between kerbs was a grey bar with the wheel hung over it);
    # a low stone edge, the water white where the paddles churn it and
    # streaked where it runs on to the pond.
    box((9.4, 0.14, 27.0), (8.6, 0.07, 2.0), MUD)
    box((8.2, 0.3, 26.0), (8.6, 0.15, 2.0), WATER)
    box((0.5, 0.42, 26.0), (12.9, 0.21, 2.0), 'grey')
    for k, (dx, dz, l) in enumerate(((1.6, -5.5, 3.2), (0.4, -8.5, 2.6), (2.6, -10.0, 2.2), (-0.6, -4.2, 1.8))):
        ground_poly([(RX + dx - 0.25, 0.32, dz), (RX + dx + 0.25, 0.32, dz), (RX + dx + 0.18, 0.32, dz - l),
                     (RX + dx - 0.18, 0.32, dz - l)], [(0, 3, 2, 1)], 'white')
    with animated('anim_bob:h=0.1:p=0.9', (RX, 0.3, -3.2)):
        for k, (dx, dz) in enumerate(((-0.7, -3.3), (0.0, -3.7), (0.7, -3.2), (0.3, -2.9), (-0.4, -2.8))):
            box((0.6, 0.5, 0.6), (RX + dx, 0.4, dz), 'white', yaw=0.6 * k)
    # the house
    F = local(0, 0, 0)
    D, L, H = 9.0, 11.0, 7.0
    box((D, H, L), (0, H / 2, 0), STONE)
    gable_roof(F, 0.0, 0.0, D, L, H, TILE, STONE)
    box((1.2, 3.0, 1.2), (-1.5, H + 4.0, -3.5), 0xb06041)
    box((0.14, 2.6, 1.6), (-0.1, 1.3, L / 2 + 0.05), 0x7a5a3a, yaw=math.pi / 2)   # its door on the downstream gable
    for z in (-3.0, 3.0):
        window(F, 0.0, D / 2, 4.6, z, w=1.2, h=1.2)
    box((1.2, 1.0, 1.0), (2.0, 0.5, L / 2 + 1.2), 0xfde4c7)                       # sacks at the door
    # the wheel, axle across (X), turning so its foot runs downstream: the
    # stream comes down the race INTO the pond (its last reach meets the
    # race's +Z end), so the foot runs toward the pond (-Z)
    WX, WY, WZ, R = RX, 3.0, 0.0, 3.4          # its foot under the water
    with animated('anim_spin:a=x:w=0.9', (WX, WY, WZ)):
        cyl(0.5, 1.8, (WX - 0.9, WY, WZ), 0x2a2735, segs=8, axis='across')
        for s in (-1, 1):
            torus(R, 0.22, (WX + s * 0.6, WY, WZ), 0x7a5a3a, segs=16, axis='across')
        for k in range(12):
            a = k * 2 * math.pi / 12
            dy, dz = math.sin(a), math.cos(a)
            box((1.4, 0.16, 1.0), (WX, WY + dy * (R - 0.3), WZ + dz * (R - 0.3)), 0x9a7b55, pitch=a)
        for k in range(4):
            a = k * math.pi / 4
            for s in (-1, 1):
                box((0.25, 0.25, 2 * R), (WX + s * 0.6, WY, WZ), 0x7a5a3a, pitch=a)
    # the pond's life: three ducks going round it, the willow, the angler
    n = 10
    for k in range(n):
        a = -k * 2 * math.pi / n
        marker('path_duck_%d' % k, (PX + 8.0 * math.cos(a), 0.3, PZ + 8.0 * math.sin(a)))
    for j in range(3):
        a0 = 0.0
        with animated('anim_path:c=duck:p=44:o=%.3f:f=1+bob:h=0.015:p=1.6#%d' % (j / 3 + 0.04 * j, j), (PX + 8.0, 0.3, PZ)):
            duck((PX + 8.0, 0.3, PZ), (0xf8f8fb, 0x9a7b55, 0xf8f8fb)[j])
    willow((PX - 10.0, 0, PZ - 8.0))
    AX, AZ = PX - PR - 2.2, PZ + 4.0
    bench((AX, 0, AZ), yaw=math.pi / 2)
    person((AX - 0.1, 0.5, AZ), 0.0, 0x22c46e, hair=1, sit=True, arm=0.6)
    with animated('anim_sway:a=z:d=9:p=4.5:r=0.75#rod', (AX + 0.3, 0.9, AZ + 0.35)):   # the rod jigs
        strut((AX + 0.3, 0.9, AZ + 0.35), (AX + 5.0, 3.0, AZ + 0.35), 0.1, 0x2a2735)
    for k, (x, z) in enumerate(((PX - 12.0, PZ + 5.0), (PX + 6.0, PZ - 11.5), (PX - 4.0, PZ + 12.6))):
        for j in range(4):
            a = j * 1.7 + k
            box((0.2, 1.8 - 0.2 * j, 0.2), (x + 0.5 * math.cos(a), 0.9 - 0.1 * j, z + 0.5 * math.sin(a)),
                (0x4f9a48, 0x61cb8b, 0x9a7b55, 0x4f9a48)[j], yaw=a)
    join_still('mill')

@piece(REAL)
def pond_ducks():
    # Life on Tangle's pond and its shore, on the half of it clear of the
    # bridge (+X toward the bridge, whose deck and spotIssue's margin start
    # 5.7 u out): two ducks going round, lily pads, reeds in the shallows of
    # the far bank and stones on the pebble shore. The pond is the track's
    # `pond` landform (its cap centred here, 5.3 u round; the renderer draws
    # its water and shore, TtpRenderer::buildPonds); its sheet lies 0.09 u
    # over the plain, so the ducks float at 0.1 u (0.4 here).
    WY, R = 0.4, 21.6                        # the water; the shore's line, 5.4 u
    n = 10
    for k in range(n):
        a = -k * 2 * math.pi / n
        marker('path_pduck_%d' % k, (10.0 * math.cos(a), WY, 12.0 * math.sin(a)))
    for j in range(2):
        with animated('anim_path:c=pduck:p=40:o=%.3f:f=1+bob:h=0.015:p=1.6#%d' % (j / 2 + 0.07, j), (10.0, WY, 0.0)):
            duck((10.0, WY, 0.0), (0xf8f8fb, 0x9a7b55)[j])
    for k, deg in enumerate((168, 212)):     # reeds in the far bank's shallows
        x, z = 19.0 * math.cos(math.radians(deg)), 19.0 * math.sin(math.radians(deg))
        for j in range(4 - k):
            a = j * 1.6 + k
            box((0.24, 2.3 - 0.3 * j, 0.24), (x + 0.7 * math.cos(a), WY + 1.05 - 0.15 * j, z + 0.7 * math.sin(a)),
                (0x4f9a48, 0x61cb8b, 0x9a7b55, 0x4f9a48)[j], yaw=a)
    for k, (x, z, r) in enumerate(((-12.0, -2.0, 1.0), (-13.5, 3.0, 0.8))):   # lily pads, flat on the water
        ground_poly([(x, WY, z)] + [(x + r * math.cos(a * math.pi / 3), WY, z + r * math.sin(a * math.pi / 3))
                                         for a in range(6)], [(0, 1 + a, 1 + (a + 1) % 6) for a in range(6)], 0x4f9a48)
    # stones on the shore: round the cap, and down both sides to the margin
    stones = [(R * math.cos(math.radians(d)), R * math.sin(math.radians(d))) for d in (125, 190, 238)]
    stones += [(7.0, -R), (17.0, -R - 0.6), (11.0, R + 0.3)]
    with plain_parts():
        for k, (x, z) in enumerate(stones):
            box((1.5 - 0.15 * (k % 3), 0.7 - 0.1 * (k % 2), 1.2), (x, 0.3, z), ('grey', 'lavender')[k % 2], yaw=0.7 * k)
    # What stands up off the water, so the pond reads from the roads round
    # it: a reed bed along the far bank's shallows, bulrushes among it, a
    # willow over it, and a plank jetty off the side bank with a rowing boat
    # tied up at its end.
    for k in range(9):
        d = math.radians(140 + 13.5 * k)
        x0, z0 = (R - 1.4) * math.cos(d), (R - 1.4) * math.sin(d)
        for j in range(5):
            a = j * 2 * math.pi / 5 + k
            h = 2.4 + 0.7 * ((j + k) % 3)
            cyl(0.0, h, (x0 + 0.7 * math.cos(a), WY - 0.2, z0 + 0.7 * math.sin(a)),
                (0x4f9a48, 0x22c46e)[(j + k) % 2], r2=0.3, segs=3, yaw=a)
        if k % 3 == 1:
            box((0.26, 0.8, 0.26), (x0, WY + 2.7, z0), 0x7a5a3a)
    willow((1.14 * R * math.cos(math.radians(205)), 0, 1.14 * R * math.sin(math.radians(205))))
    JX = 3.0
    for i in range(9):
        box((2.2, 0.16, 1.0), (JX, 0.72, R + 1.5 - i * 1.05), 0x8a5f3e)
    for i in (0, 4, 8):
        for sx in (-1, 1):
            box((0.24, 1.2, 0.24), (JX + sx * 1.0, 0.4, R + 1.5 - i * 1.05), 0x7a5a3a)
    BX, BZ = JX + 2.3, R - 5.2
    box((1.6, 0.6, 3.6), (BX, WY + 0.3, BZ), 0xcf534f)
    box((1.15, 0.6, 1.15), (BX, WY + 0.3, BZ - 1.9), 0xcf534f, yaw=math.pi / 4)
    box((1.75, 0.12, 3.7), (BX, WY + 0.62, BZ), 'white')
    box((1.4, 0.14, 0.4), (BX, WY + 0.66, BZ + 0.4), 0x9a7b55)
    join_still('pond')

# ---- TANGLE: the culverts where the brook goes under the low road ---------------------

@piece()
def culvert():
    # The stone barrel that carries the brook under the low road on the run to
    # the line, seen where it comes out each side: a low barrel along the
    # stream (+X toward the road), its inner end at spotIssue's 1.2 u past the
    # deck, and at its outer end a headwall with a dark arched mouth over the
    # water and wing walls splayed along the banks. World units. Low (its top
    # a hand over the road's surface), so it reads as the road's own
    # embankment over the brook, not a box beside it; no parapet along the
    # kerb. The water itself is the stream reach under it.
    L, W, HB = 2.4, 2.6, 0.55               # the barrel: length, width, height
    T, WH, HH, R = 0.35, 3.4, 0.8, 0.72     # the headwall: thickness, width, height; the mouth's radius
    box((L, HB, W), (-L / 2, HB / 2, 0), 'grey')
    x = -L - T / 2 + 0.05
    box((T, HH, WH), (x, HH / 2, 0), 'lavender')
    face = x - T / 2 - 0.02
    def mouth(fx, r):
        arc = [(fx, r * math.sin(math.pi * k / 8), r * math.cos(math.pi * k / 8)) for k in range(9)]
        poly([(fx, 0.0, 0.0)] + arc, [(0, k + 1, k + 2) for k in range(8)], 0x2a2735)
    mouth(face, R)                           # where the brook comes out, away from the road
    mouth(0.02, 0.42)                        # and the barrel's end at the road, the water going under it
    for sd in (-1, 1):                       # wing walls, short and splayed along the banks
        box((0.8, 0.45, 0.42), (face - 0.3, 0.225, sd * (WH / 2 + 0.05)), 'grey', yaw=sd * 0.45)
    join_still('culvert')

# ---- CLOVERLEAF: the boating lake ----------------------------------------------------
# The park's boating lake in the finger lobe, the track's `pond` landform (its
# water and shore drawn by the renderer, 14 round a spine 32 long here), and
# its life: swan pedalos going slowly round and the fountain playing in the
# middle, a fat white plume and its spray crown. The boathouse, its jetty and
# the willows on the banks are pieces of their own, each standing clear of
# the kerbs: a piece's box holds the verge band down under it (bandHold), and
# one box round the lake and its shores would reach the road. Metres, +Z
# along the lake.
LAKE_Y = 0.36

def swan_pedalo(at, body):
    """A swan pedalo facing +X: the white hull, the seat's blue back, the
    swan's neck and head at the bow."""
    x, y, z = at
    box((2.6, 0.7, 1.6), (x, y + 0.35, z), body)
    box((1.6, 0.5, 1.4), (x - 0.4, y + 0.85, z), 0x339cf2)                      # the seat back
    strut((x + 1.0, y + 0.6, z), (x + 1.5, y + 2.0, z), 0.4, body)               # the neck
    box((0.7, 0.45, 0.4), (x + 1.75, y + 2.1, z), body)                          # the head
    box((0.4, 0.15, 0.2), (x + 2.2, y + 2.05, z), 0xff7e44)                      # the beak

@piece(REAL)
def boating_lake():
    # The lake beyond the finger lobe's end (the `pond`, 16 u across, 36 long
    # here): four swan pedalos going slowly round and the fountain in the
    # middle, the park's tallest thing, straight ahead down the lobe's run.
    WY = LAKE_Y
    n = 16
    for k in range(n):
        a = -k * 2 * math.pi / n
        marker('path_pedalo_%d' % k, (12.0 + 10.0 * math.cos(a), WY, 30.0 * math.sin(a)))
    for j in range(3):
        with animated('anim_path:c=pedalo:p=110:o=%.3f:f=1+bob:h=0.03:p=2.2#%d' % (j / 3, j), (22.0, WY, 0.0)):
            swan_pedalo((22.0, WY, 0.0), 'white')
    # the fountain on its stone basin: a fat plume, faintly blue, and its
    # spray falling outward round the top in a ring of drops, rising and
    # falling gently
    FX = -15.0                                    # toward the near bank, where the road looks
    cyl(3.4, 0.9, (FX, 0.0, 0.0), 'grey', segs=12)
    cyl(3.0, 0.2, (FX, 0.9, 0.0), 0x8ecae6, segs=12)
    cyl(0.5, 2.2, (FX, 0.9, 0.0), 'grey', segs=8)
    cyl(1.6, 0.35, (FX, 3.0, 0.0), 'grey', r2=1.9, segs=10)
    cyl(0.6, 4.2, (FX, 3.3, 0.0), 'sky', r2=0.18, segs=8)                        # the jet
    with animated('anim_bob:h=0.15:p=2.2', (FX, 6.0, 0.0)):
        for k in range(6):                       # its water falling back into the bowl
            a = k * math.pi / 3
            with plain_parts():
                strut((FX, 7.4, 0.0), (FX + 1.5 * math.cos(a), 5.4, 1.5 * math.sin(a)), 0.2, 'white')
            box((0.36, 0.5, 0.36), (FX + 1.5 * math.cos(a), 5.3, 1.5 * math.sin(a)), 'white', yaw=a)
    # an islet off the far bank, a young cherry on it and reeds at its foot:
    # what breaks the water's outline, as a park lake's does
    IX, IZ = -3.0, 17.0
    sphere(6.5, (IX, WY - 0.6, IZ), 0x5f9f4a, subdiv=1, scale=(1.25, 0.28, 1.0), yaw=0.5)
    lawn_cherry(IX + 0.5, IZ, 1.25, 'pink', 3)
    lawn_cherry(IX - 3.5, IZ + 2.5, 0.7, 'white', 1)
    for j in range(7):
        a = j * 0.9
        cyl(0.0, 2.2 + 0.5 * (j % 3), (IX + 7.2 * math.cos(a), WY - 0.2, IZ + 5.8 * math.sin(a)),
            (0x4f9a48, 0x22c46e)[j % 2], r2=0.28, segs=3, yaw=a)
    for k, (x, z, r) in enumerate(((8.0, 30.0, 1.4), (10.5, 33.0, 1.0), (-6.0, -34.0, 1.3), (-9.0, -31.0, 1.0),
                                   (14.0, -18.0, 1.1))):                           # lily pads
        ground_poly([(x, WY + 0.02, z)] + [(x + r * math.cos(q * math.pi / 3), WY + 0.02, z + r * math.sin(q * math.pi / 3))
                                           for q in range(6)], [(0, 1 + (q + 1) % 6, 1 + q) for q in range(6)], 0x4f9a48)
    join_still('lake')

@piece(REAL)
def boathouse():
    # The lake's boathouse on its near shore: a timber boat shed under a red
    # tiled roof, white at its corners and eaves, the hire hatch under a
    # plain canopy toward the road (+X), the wide boat door open on the lake
    # side with a rowing boat on the slip in it, the jetty out over the water
    # and two swan pedalos tied up there, a flag over the ridge. It stands
    # LEVEL on the bank (draped it leaned with the slope): the bank is the
    # pond's own flat floor here.
    RED, WHITE, BOARD = 0xcf534f, 0xf8f8fb, 0x9a7b55
    F = local(0.0, 0.0, 0.0)
    D, L, H = 5.0, 7.0, 3.0
    box((D + 0.6, 0.3, L + 0.6), (0.0, 0.15, 0.0), 'grey')                    # the stone footing
    box((D, H, L), (0.0, 0.3 + H / 2, 0.0), BOARD)
    ridge = gable_roof(F, 0.0, 0.3, D, L, H, RED, BOARD, t=0.3, over=0.45)
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((0.3, H, 0.3), (sx * D / 2, 0.3 + H / 2, sz * L / 2), WHITE)  # the corner boards
    box((0.12, 1.2, 2.2), (D / 2 + 0.03, 2.0, 1.2), 0x2a2735)                 # the hire hatch
    box((0.5, 0.14, 2.4), (D / 2 + 0.25, 1.36, 1.2), WHITE)                   # its sill
    box((1.3, 0.12, 2.8), (D / 2 + 0.6, 2.85, 1.2), WHITE, roll=-0.2)         # its canopy
    box((0.12, 2.1, 1.0), (D / 2 + 0.03, 1.35, -2.0), 0x339cf2)               # the door
    with plain_parts():
        for sz in (-1, 1):                                                   # a lifebuoy each side of the hatch
            for j in range(8):
                a = j * math.pi / 4
                box((0.16, 0.36, 0.36), (D / 2 + 0.1, 2.0 + 0.5 * math.sin(a), 1.2 + sz * 1.9 + 0.5 * math.cos(a)),
                    (RED, WHITE)[j % 2], pitch=a)
    box((0.14, 2.3, 3.6), (-D / 2 - 0.03, 1.45, 0.0), 0x2a2735)               # the boat door, open to the lake
    box((0.2, 0.2, 4.0), (-D / 2 - 0.05, 2.7, 0.0), WHITE)
    flagpole(F(0.0, ridge - 0.2, 0.0), 2.8, RED, w=1.3, fh=0.8, pole=WHITE, wave='anim_sway:a=z:d=22:p=1.7#boat')
    for i in range(10):                                                      # the jetty
        box((1.0, 0.16, 2.6), (-D / 2 - 0.6 - i * 1.05, 0.55, 0.0), TIMBER)
    for sz in (-1, 1):
        for i in (0, 4, 9):
            box((0.24, 1.0, 0.24), (-D / 2 - 0.6 - i * 1.05, 0.25, sz * 1.2), 0x7a5a3a)
    BX = -D / 2 - 5.0                                                        # a rowing boat alongside
    box((3.4, 0.5, 1.3), (BX, LAKE_Y + 0.25, -2.4), 0x339cf2)
    box((1.0, 0.5, 1.0), (BX - 1.8, LAKE_Y + 0.25, -2.4), 0x339cf2, yaw=math.pi / 4)
    box((3.5, 0.1, 1.4), (BX, LAKE_Y + 0.52, -2.4), WHITE)
    box((0.3, 0.12, 1.2), (BX + 0.3, LAKE_Y + 0.56, -2.4), BOARD)
    for sz in (-1, 1):
        swan_pedalo((-D / 2 - 9.5, LAKE_Y, sz * 2.8), 'white')
    join_still('boathouse')

@piece(REAL)
def lake_reeds():
    # The lake's west bank: reeds standing in clumps at the water's edge and
    # round shrubs banked up behind them, so from the return leg the water
    # lies against a green bank, not flat lawn, and the first leg passes a
    # lakeside, not grass. The pond's water stays on the plain and the land
    # cannot rise in a loop ringed by road, so the bank is built. Along Z,
    # +X toward the water. It DRAPES.
    def still():
        for k in range(9):
            z = -15.0 + 3.75 * k + 0.8 * math.sin(k * 2.1)
            for j in range(5):                                               # a clump of reeds
                a = j * 2 * math.pi / 5 + k
                x = 3.4 + 0.6 * math.cos(a)
                h = 2.2 + 0.6 * ((j + k) % 3)
                cyl(0.0, h, (x, -0.2, z + 0.6 * math.sin(a)), (0x4f9a48, 0x22c46e)[(j + k) % 2], r2=0.26, segs=3, yaw=a)
            if k % 3 == 1:                                                   # a bulrush head or two
                box((0.24, 0.7, 0.24), (3.4, 2.6, z), 0x7a5a3a)
        for k, (x, z, r) in enumerate(((-1.5, -13.0, 2.2), (-2.6, -8.0, 2.6), (-1.2, -3.0, 2.0), (-2.4, 2.0, 2.7),
                                       (-1.4, 7.0, 2.2), (-2.5, 12.0, 2.4), (0.4, -10.5, 1.6), (0.6, 4.5, 1.7))):
            sphere(r, (x, r * 0.35, z), (0x4f9a48, 0x5f9f4a)[k % 2], scale=(1.1, 0.8, 1.0), yaw=k)
    draped('reeds', still)

@piece(REAL)
def alder_grove():
    # A clump of the valley's alders by the road on Tangle's lawns, a willow
    # at its end: the wood's own trees where no hillside stands. Front (+X)
    # to the road, the crowns inside x 3.4. It DRAPES.
    def still():
        lawn_alder(0.0, -4.5, 1.0, 0.4)
        lawn_alder(-3.2, 2.0, 1.2, 2.1)
        lawn_alder(-7.5, -2.5, 1.1, 3.6)
        lawn_alder(-1.0, 8.0, 0.85, 5.0)
    draped('grove', still)

# ---- CLOVERLEAF: the park's cherry trees in blossom ----------------------------------
# The park's own tree, the thing a racer sees beside every stretch of its
# road: ornamental cherries in full blossom, pink and white, their petals
# fallen in a ring on the mown lawn under each, a bench facing the road. The
# lawn's scatter is the kit's conifers on all four gardens, so the blossom is
# what says park. Front (+X) to the road, the crowns inside x 3.4 like the
# grove's, so it stands where a grove stood. It DRAPES.
def cherry_petals(x, z, k, i):
    """The petals fallen under a cherry: a ragged pale ring on the lawn."""
    n, R = 9, 2.5 * k
    rim = [(x + R * (0.75 + 0.3 * hash01(i, q)) * math.cos(q * 2 * math.pi / n), 0.07,
            z + R * (0.75 + 0.3 * hash01(q, i)) * math.sin(q * 2 * math.pi / n)) for q in range(n)]
    ground_poly([(x, 0.07, z)] + rim, [(0, 1 + (q + 1) % n, 1 + q) for q in range(n)], 'blossom')['ramp'] = 0.1

def blossom_trees(trees, seat=None):
    def still():
        for i, (x, z, k, c) in enumerate(trees):
            lawn_cherry(x, z, k, c, i)
            cherry_petals(x, z, k, i)
        if seat:
            bench(seat, yaw=math.pi / 2)
    draped('blossom', still)

# An avenue of cherries beside the road, the way a park plants them: two
# rows with a grass walk between, the trees of different ages, benches under
# them. No path is laid: a gravel strip draped up a hillside read as a tan
# stripe from across the lap. Along Z; front (+X) to the road, the near row's
# crowns inside x 3.4. It DRAPES.
@piece(REAL)
def cherry_avenue():
    PX, PW = -3.4, 1.7
    def still():
        row = (((0.2, -24.0, 1.15, 'pink'), (-0.2, -13.0, 0.8, 'white'), (0.3, -2.0, 1.25, 'pink'),
                (0.0, 10.0, 0.9, 'pink'), (0.2, 22.0, 1.1, 'white')),
               ((-7.0, -19.0, 0.95, 'white'), (-6.6, -7.0, 1.2, 'pink'), (-7.1, 4.5, 0.75, 'pink'),
                (-6.8, 16.0, 1.3, 'white'), (-7.0, 26.0, 0.9, 'pink')))
        i = 0
        for line in row:
            for x, z, k, c in line:
                lawn_cherry(x, z, k, c, i)
                cherry_petals(x, z, k, i)
                i += 1
        bench((PX - PW - 0.7, 0, 3.0), yaw=math.pi / 2)
        bench((PX - PW - 0.7, 0, -20.0), yaw=math.pi / 2)
    draped('avenue', still)

@piece(REAL)
def blossom_grove():
    blossom_trees(((0.0, -5.0, 1.0, 'pink'), (-3.5, 3.5, 0.9, 'white'), (-7.5, -2.5, 1.15, 'pink')), seat=(1.8, 0, 2.0))

@piece(REAL)
def blossom_grove_b():
    blossom_trees(((-0.5, 4.5, 1.1, 'white'), (-4.0, -4.0, 0.95, 'pink'), (-8.0, 3.0, 1.0, 'white'), (-1.0, -9.5, 0.8, 'pink')))

# The park's bandstand on the top of the mound beside the high road, level
# with a racer up on the deck: an octagon of white posts on a stone base
# under a red tented roof, its flag flying, bunting out to four poles, a
# cherry either side and benches facing it. Front (+X) to the road.
@piece(REAL)
def bandstand():
    # On the crown of its own knoll (SET_GROUND, a broad round top): the floor
    # lies flush in the turf, a stone kerb round it sunk into the ground, the
    # posts off the floor, and every other part (the bunting's poles, the
    # benches, the steps down the road side) stands where the knoll's ground
    # is under it. No base to stand proud of a slope.
    RED, WHITE = 0xcf534f, 'white'
    H = set_ground('bandstand')
    s0 = H(0.0, 0.0)
    cyl(3.7, 0.9, (0, s0 - 0.75, 0), 'cream', segs=8)                 # the kerb, its top a hand over the turf
    cyl(3.3, 0.1, (0, s0 + 0.15, 0), 0x9a7b55, segs=8)                # the boards
    F0 = s0 + 0.25
    for k in range(8):
        a = k * math.pi / 4 + math.pi / 8
        x, z = 3.0 * math.cos(a), 3.0 * math.sin(a)
        box((0.22, 3.2, 0.22), (x, F0 + 1.6, z), WHITE, yaw=-a)
        b = (k + 1) * math.pi / 4 + math.pi / 8
        if k != 0 and k != 7:                                      # the rail, open to the road
            strut((x, F0 + 0.9, z), (3.0 * math.cos(b), F0 + 0.9, 3.0 * math.sin(b)), 0.14, WHITE)
    cyl(4.3, 0.3, (0, F0 + 3.2, 0), WHITE, segs=8)
    cyl(4.1, 2.4, (0, F0 + 3.5, 0), RED, r2=0.35, segs=8)
    cyl(0.12, 1.2, (0, F0 + 5.9, 0), WHITE, segs=6)
    sphere(0.3, (0, F0 + 7.1, 0), 'yellow', subdiv=1)
    for k, (px, pz) in enumerate(((7.5, 7.5), (7.5, -7.5), (-7.5, 7.5), (-7.5, -7.5))):
        g = H(px, pz)
        top = F0 + 3.4
        box((0.2, top - g + 0.4, 0.2), (px, (top + g - 0.4) / 2, pz), WHITE)
        a = math.atan2(pz, px)
        bunting((4.2 * math.cos(a), F0 + 3.4, 4.2 * math.sin(a)), (px, top - 0.1, pz),
                (0xff5040, 0xffc044, 0x339cf2, 0x22c46e, 'white'), n=7)
    for z in (-3.2, 3.2):
        bench((6.0, H(6.0, z), z), yaw=math.pi / 2)
    for i in range(7):                                             # stone steps down the road side
        x = 4.2 + 1.1 * i
        box((1.15, 0.5, 2.2), (x, H(x + 0.5, 0.0) - 0.12, 0.0), 'grey')
    join_still('bandstand')

# ---- PRETZEL: the downs' old oaks ------------------------------------------------------
# High summer on Pretzel's downs: two of the garden's broadleaf oaks (the
# grove's tree, one grown big) with the hay made beside them, three round
# bales lying in the cut grass. The lawn's scatter is kept thin there, so
# these are the trees a racer passes. Front (+X) to the road. It DRAPES.
@piece(REAL)
def summer_oaks():
    def still():
        lawn_oak(-1.5, -5.0, 1.3)
        lawn_oak(-5.0, 6.0, 1.0)
        before = set(bpy.context.scene.objects)
        for x, z, yaw in ((2.4, 1.5, 0.3), (1.4, 5.0, 1.2), (2.8, -2.4, -0.5)):
            round_bale((x, 0.0, z), yaw)
        for o in bpy.context.scene.objects:      # straw yellow (the hay meadow's)
            if o not in before:
                o['ramp'] = 0.25
    draped('oaks', still)

# ---- TANGLE: the valley's woods ----------------------------------------------------------
# The mill valley's sides are wooded: a stand of its alders up a hillside,
# a willow or two at its front, front (+X) to the road and the stream, deep
# enough that the slope behind the first trees is trees too. It DRAPES,
# each tree on the slope as drawn. Turned half round for the next stand
# along, so no two neighbours are the same wood.
MILL_WOOD = ((-1.0, -26.0, 17.0), (-3.0, -15.0, 20.0), (0.5, -5.0, 16.0), (-2.0, 6.0, 21.0), (0.0, 17.0, 17.5),
             (-2.5, 27.0, 19.0), (-10.0, -21.0, 21.0), (-11.0, -9.0, 18.0), (-9.0, 1.0, 22.5), (-11.5, 12.0, 19.0),
             (-9.5, 23.0, 21.5), (-19.0, -15.0, 22.0), (-20.0, -3.0, 20.0), (-18.0, 8.0, 23.0), (-20.5, 19.0, 20.5),
             (-28.0, -9.0, 22.0), (-29.0, 3.0, 23.5), (-27.0, 14.0, 21.0),
             (-6.0, -20.5, 18.0), (-5.5, 0.0, 19.0), (-6.5, 21.0, 17.0), (-14.5, -4.0, 21.0), (-15.0, 16.0, 20.0),
             (-24.0, -12.0, 22.0), (-24.5, 9.0, 21.5))

@piece(REAL)
def mill_wood():
    draped('wood', lambda: [lawn_alder(x, z, k / 17.0, 1.7 * i) for i, (x, z, k) in enumerate(MILL_WOOD)])

@piece(REAL)
def mill_wood_lite():
    # The lite tier's wood: every other tree (a stand up a slope is what the
    # box's cells barely see; native/renderer/CLAUDE.md, the detail tier).
    draped('wood', lambda: [lawn_alder(x, z, k / 17.0, 1.7 * i) for i, (x, z, k) in enumerate(MILL_WOOD) if i % 2 == 0])

# ---- the lawn's scatter ---------------------------------------------------------------
# One tree each, the scatter's models (theme.cc grassScenery; a stamp sizes
# and turns it): the families above, so a track's scattered trees are its
# set pieces' trees. And the lawn's shrub, the scatter's bush.
def scatter_tree(build):
    build()
    join_still('tree')

@piece(REAL)
def tree_oak():
    scatter_tree(lambda: lawn_oak(0.0, 0.0, 1.0))

@piece(REAL)
def tree_cherry():
    scatter_tree(lambda: lawn_cherry(0.0, 0.0, 1.0, 'pink'))

@piece(REAL)
def tree_cherry_white():
    scatter_tree(lambda: lawn_cherry(0.0, 0.0, 1.0, 'white', 2))

@piece(REAL)
def tree_alder():
    scatter_tree(lambda: lawn_alder(0.0, 0.0, 1.0))

@piece(REAL)
def tree_willow():
    scatter_tree(lambda: willow((0.0, 0.0, 0.0)))

@piece(REAL)
def tree_apple():
    scatter_tree(lambda: apple_tree(0.0, 0.0, 3, False, apples=3, top=False))

@piece(REAL)
def tree_apple_lite():
    # The lite tier's: the orchard's lite tree, one lobe.
    scatter_tree(lambda: apple_tree(0.0, 0.0, 3, True))

@piece(REAL)
def tree_poplar():
    scatter_tree(lambda: lawn_poplar(0.0, 0.0, 1.0))

@piece(REAL)
def lawn_shrub():
    def build():
        for (x, y, z), r in (((0.0, 0.9, 0.0), 1.5), ((1.3, 0.6, 0.6), 1.05), ((-0.9, 0.55, -0.9), 0.95)):
            sphere(r, (x, y, z), 0x5f9f4a, subdiv=1, scale=(1.1, 0.8, 1.0))
    scatter_tree(build)

# ---- PRETZEL: the kite hill --------------------------------------------------------
# Three children down the face of the hill beyond the top loop (tracks.js
# `land`), standing still with their kites up: a long dragon kite, a diamond
# and a box kite, low over the hill's foot toward the road's verge, bright,
# with long ribboned tails, nodding in the wind about the ends of their
# strings. The road comes at the hill head-on before it turns past, so the
# kites spread along it and face it: the approach sees every one face-on.
# The children stand; the wind moves the kites. Front (+X) to the road,
# metres; on the left at yaw 180. The children DRAPE onto the hill as drawn.
def kite_string(a, b, n=6):
    """A kite's string from the hand at a up to the kite at b, sagging a little."""
    pts = sag(a, b, 0.06 * math.dist(a, b), n + 1)
    with plain_parts():
        for i in range(n):
            strut(pts[i], pts[i + 1], 0.08, 'white')

def kite_tail(top, colors, n=6):
    """A kite's tail streaming from `top` downwind (+Z), dropping as it goes
    and snaking a little sideways: a ribbon with a bow tied on it every so
    often."""
    with plain_parts():
        pts = [(top[0] + 0.35 * math.sin(0.9 * i), top[1] - 0.45 * i - 0.04 * i * i, top[2] + 0.85 * i)
               for i in range(n + 1)]
        for i in range(n):
            strut(pts[i], pts[i + 1], 0.08, 'white')
            box((0.12, 0.3, 0.7), pts[i + 1], colors[i % len(colors)], yaw=0.5 * i)

@piece(REAL)
def kite_flyers():
    # Three children on the hill's face with their kites up: small kites, a
    # real kite's size beside a child, high over the hill behind them on long
    # lines, nodding gently. Front (+X) to the road; the children DRAPE.
    RED, BLUE, YELLOW, GREEN, PURPLE = 0xcf534f, 0x339cf2, 0xffc044, 0x22c46e, 0xa878e8
    KIDS = ((12.0, -10.0, BLUE, 2), (13.0, 6.0, RED, 0), (12.5, 18.0, GREEN, 3))
    DRAGON = (3.0, 11.0, -16.0)                  # the dragon's head, its body trailing along +Z
    DIAMOND = (4.0, 13.5, 9.0)
    BOX = (1.0, 10.0, 26.0)
    def still():
        for (x, z, shirt, hair), k in zip(KIDS, (DRAGON, DIAMOND, BOX)):
            person((x, 0.0, z), math.pi, shirt, k=1.0, hair=hair, arm=1.1)
            kite_string((x - 0.52, 1.2, z + 0.35), k, n=8)                # from the hand
    draped('kids', still)
    hx, hy, hz = DRAGON
    with animated('anim_drape+sway:a=x:d=5:p=4.6#dragon', DRAGON):
        box((1.1, 1.9, 2.0), (hx, hy, hz), RED)                                 # the head
        for s in (-1, 1):
            box((0.2, 0.4, 0.4), (hx + 0.5, hy + 0.3, hz + s * 0.45), YELLOW)   # its eyes
        COLS = (YELLOW, GREEN, BLUE, RED)
        prev = (hx, hy + 0.5, hz + 0.8)
        for i in range(6):
            t = (i + 1) / 6
            z = hz + 1.9 + 1.9 * i
            y = hy - 1.0 * math.sin(math.pi * t) + 0.3 * math.sin(2.5 * t * math.pi)
            r = 1.25 - 0.07 * i
            cyl(r, 0.2, (hx - 0.1, y, z), COLS[i % 4], segs=10, axis='across')
            rim = (hx, y + r, z)
            strut(prev, rim, 0.1, 'white')
            prev = rim
    S = 1.6
    kx, ky, kz = DIAMOND
    with animated('anim_drape+sway:a=x:d=6:p=3.8#diamond', DIAMOND):
        poly([(kx, ky + 2.4 * S, kz), (kx, ky, kz - 1.5 * S), (kx, ky - 3.0 * S, kz), (kx, ky, kz + 1.5 * S)],
             [(0, 1, 2), (0, 2, 3)], BLUE)
        poly([(kx + 0.05, ky + 2.4 * S, kz), (kx + 0.05, ky, kz + 1.5 * S), (kx + 0.05, ky - 3.0 * S, kz)],
             [(0, 1, 2)], YELLOW)
        kite_tail((kx, ky - 3.0 * S, kz), (RED, YELLOW, GREEN), n=4)
    S = 1.5
    kx, ky, kz = BOX
    with animated('anim_drape+sway:a=x:d=6:p=4.2#box', BOX):
        for s in (-1, 1):
            box((1.4 * S, 1.2 * S, 1.4 * S), (kx, ky + s * 1.0 * S, kz), (RED, PURPLE)[s > 0])
        for sx in (-1, 1):
            for sz in (-1, 1):
                box((0.12, 3.4 * S, 0.12), (kx + sx * 0.65 * S, ky, kz + sz * 0.65 * S), 'white')
        kite_tail((kx, ky - 1.7 * S, kz), (YELLOW, BLUE), n=4)

# ---- TANGLE: the springhouse the stream rises under -------------------------------
# The stream's source, at the toe of the hill beyond the north loop's top
# straight (tracks.js `land`), where the road heads straight at it: a small
# fieldstone springhouse cut into the slope under a red roof, its back wall in
# the hill so the grass runs up behind it, a weathervane turning on the ridge.
# The spring spills white out of a dark arch under its front, down a short
# stone channel into a pool banded as a pond is, a heron on the pool's road
# side; from the pool it runs into the drain by the kerb (set-spring-drain).
# The house and its channel stand LEVEL on the ground the hill draws here
# (SPRING_HILL, a scratch probe, not a source); the pool, its reeds and the
# heron DRAPE. Metres, front (+X) to the road; on the left at yaw 180.
SPRING_HILL_X0, SPRING_HILL_DX = -26.0, 2.0
SPRING_HILL = {      # ground over the piece's foot, metres, by z (rows) and x (-26 .. 10)
    -9: (20.5, 20.2, 20.0, 19.7, 19.5, 17.5, 15.1, 12.8, 10.6, 8.3, 6.0, 3.7, 2.0, 1.7, 1.4, 0.9, 0.9, 0.9, 0.7),
    -6: (20.5, 20.0, 19.6, 19.4, 19.1, 17.2, 14.8, 12.4, 10.0, 7.9, 5.6, 3.3, 1.6, 1.3, 0.9, 0.6, 0.6, 0.6, 0.7),
    -3: (20.5, 19.8, 19.1, 18.9, 18.6, 16.7, 14.3, 11.9, 9.6, 7.7, 5.5, 3.2, 1.5, 1.3, 0.9, 0.6, 0.6, 0.6, 0.6),
    0: (20.3, 19.5, 18.6, 18.4, 18.1, 16.2, 13.8, 11.4, 9.1, 7.3, 5.4, 3.1, 1.4, 1.2, 0.9, 0.6, 0.5, 0.5, 0.5),
    3: (19.0, 18.5, 18.1, 17.9, 17.6, 15.8, 13.4, 11.0, 8.6, 6.8, 5.0, 3.0, 1.3, 1.1, 0.9, 0.6, 0.5, 0.5, 0.5),
    6: (18.0, 17.8, 17.6, 17.4, 17.1, 15.3, 12.9, 10.5, 8.1, 6.3, 4.5, 2.7, 1.2, 1.0, 0.8, 0.6, 0.5, 0.5, 0.5),
    9: (17.5, 17.1, 16.8, 16.4, 16.1, 15.0, 12.6, 10.2, 7.8, 6.5, 4.7, 3.0, 1.3, 1.1, 0.9, 0.7, 0.6, 0.5, 0.5),
}

def spring_hill(x, z):
    zs = sorted(SPRING_HILL)
    z = max(zs[0], min(zs[-1], z))
    def row(zk):
        r = SPRING_HILL[zk]
        f = max(0.0, min(len(r) - 1.001, (x - SPRING_HILL_X0) / SPRING_HILL_DX))
        i = int(f)
        return r[i] + (r[i + 1] - r[i]) * (f - i)
    for z0, z1 in zip(zs, zs[1:]):
        if z0 <= z <= z1:
            t = (z - z0) / (z1 - z0)
            return row(z0) + (row(z1) - row(z0)) * t
    return row(zs[-1])

@piece(REAL)
def springhouse():
    STONE, ROOF, WOOD = 0x7d6f5f, 0xcf534f, 0x7a5a3a
    HX, D, L, H = -3.7, 4.6, 5.6, 3.2           # the house: centre x, across, along, wall height
    y0 = min(spring_hill(HX + D / 2, z) for z in (-L / 2, 0.0, L / 2)) - 0.3   # the front's foot, set in
    F = local(HX, 0.0, 0.0)
    # the walls, down to the piece's foot (all of it under the hill's ground,
    # the back ones in the slope), a plinth of bigger stones along the front's foot
    box((D, y0 + H, L), (HX, (y0 + H) / 2, 0.0), STONE)
    rowed(box((0.5, 0.6, L + 0.4), (HX + D / 2 + 0.05, y0 + 0.3, 0.0), 'grey'), SLATE_ROW)
    ridge = gable_roof(F, 0.0, y0, D, L, H, ROOF, STONE, t=0.35, over=0.45)
    # the front: a plank door, a slatted vent high in it, the arch the spring runs out of
    AZ = 0.4                                     # the arch, over the pool's deep end
    box((0.14, 2.1, 1.3), (HX + D / 2 + 0.05, y0 + 1.65, -1.7), WOOD)
    for k in range(3):
        box((0.1, 0.12, 1.0), (HX + D / 2 + 0.08, y0 + 2.75 - 0.24 * k, AZ), 0x2a2735)
    box((0.12, 0.9, 1.5), (HX + D / 2 + 0.08, y0 + 0.75, AZ), 0x2a2735)
    # the weathervane on the ridge: a post, and an arrow with a cockerel turning on it
    vx = HX
    strut((vx, ridge, 1.6), (vx, ridge + 1.5, 1.6), 0.12, 'dark')
    with animated('anim_spin:a=y:w=0.35#vane', (vx, ridge + 1.4, 1.6)):
        box((1.6, 0.08, 0.08), (vx, ridge + 1.4, 1.6), 'dark')
        poly([(vx + 0.8, ridge + 1.4, 1.6), (vx + 0.5, ridge + 1.6, 1.6), (vx + 0.5, ridge + 1.2, 1.6)], [(0, 1, 2)], 'dark')
        poly([(vx - 0.8, ridge + 1.25, 1.6), (vx - 0.5, ridge + 1.4, 1.6), (vx - 0.8, ridge + 1.55, 1.6)], [(0, 1, 2)], 'dark')
        box((0.5, 0.4, 0.08), (vx + 0.1, ridge + 1.75, 1.6), 0xcf534f)
    # round shrubs bedding the house into the slope, a darker green than the lawn
    for k, (dx, dz, r) in enumerate(((-0.8, -3.6, 1.3), (0.6, 3.7, 1.1), (-2.2, 3.4, 1.4), (-2.0, -3.3, 1.2))):
        x, z = HX + dx, dz
        sphere(r, (x, spring_hill(x, z) + 0.2, z), 0x4f9a48, scale=(1.1, 0.85, 1.0), yaw=k)
    # the water leaving the arch: a white tongue spilling off its sill, then
    # the channel to the pool, white down the middle where it runs fast, the
    # pond's blue at its edges, stone either side
    cx0, cx1, cz = HX + D / 2 + 0.1, -0.3, AZ
    ya, yb = spring_hill(cx0, cz), spring_hill(cx1, cz)
    for z0, z1, row in ((-0.55, -0.2, 19), (-0.2, 0.2, None), (0.2, 0.55, 19)):
        o = skin([(cx0, ya + 0.12, cz + z0), (cx0, ya + 0.12, cz + z1), (cx1, yb + 0.12, cz + z1), (cx1, yb + 0.12, cz + z0)],
                 [(0, 1, 2, 3)], 'white' if row is None else 'sky', (0, 1, 0))
        if row is not None:
            rowed(o, row)
    skin([(cx0 - 0.02, ya + 0.32, cz - 0.6), (cx0 - 0.02, ya + 0.32, cz + 0.6), (cx0 + 0.55, ya + 0.2, cz + 0.42),
          (cx0 + 0.75, ya + 0.2, cz), (cx0 + 0.55, ya + 0.2, cz - 0.42)], [(0, 1, 2, 3, 4)], 'white', (0.4, 1, 0))
    for s in (-1, 1):
        rowed(strut((cx0, ya + 0.15, cz + s * 0.75), (cx1, yb + 0.15, cz + s * 0.75), 0.45, 'grey'), SLATE_ROW)
    join_still('springhouse')
    # the pool (draped), reeds round its far side, the heron on its road
    # side, flecks turning on it
    PX, PZ, PR = 2.0, 0.4, 2.6
    def still():
        spring_pool(PX, PZ, PR, deep=(-1.0, 0.0), gap=1.6, stones=False)   # nothing in front of the arch
        pool_heron(PX, PZ, PR, -40)                # grass behind it from the road, not the wall
        for k, a_ in enumerate((100, 235, 260)):
            r = PR * 1.12
            cx, cz_ = PX + r * math.cos(math.radians(a_)), PZ + r * math.sin(math.radians(a_))
            for j in range(4):
                aa = j * 2 * math.pi / 4 + k
                cyl(0.2, 1.6 + 0.4 * ((j + k) % 3), (cx + 0.4 * math.cos(aa), -0.2, cz_ + 0.4 * math.sin(aa)),
                    (0x4f9a48, 0x22c46e)[(j + k) % 2], r2=0.0, segs=3, yaw=aa)
    draped('spring', still)
    with animated('anim_drape+spin:a=y:w=0.3#flecks', (PX, 0.2, PZ)):
        for k in range(6):
            a = k * 2 * math.pi / 6
            box((0.55, 0.08, 0.25), (PX + 1.5 * math.cos(a), 0.2, PZ + 1.5 * math.sin(a)), 'white', yaw=a)

# ---- TANGLE: where the spring goes under the road ---------------------------------
# The spring's run, from the pool on to the kerb: a shallow channel edged in
# rounded stones of the lifted slate, its water in the pond's blues, a white
# riffle where it drops into the dark mouth of the drain under a low lip,
# going under the top straight there to come out of the same drain on the
# far side and run on as the stream. Low and round, so no slab and no point
# stands by the kerb. It stands LEVEL (nothing in it drapes): its footprint
# holds the hill's `near` ramp back off the pool behind it, as the culvert
# that stood here did. World units, front (+X) to the road; on the left at
# yaw 180.
SLATE_ROW = 30     # the grey ramp's slate, lighter than 'slate': lit faces at about 45%, shaded over 32%

@piece()
def spring_drain():
    for z0, z1, row in ((-0.55, -0.25, 19), (-0.25, 0.25, 27), (0.25, 0.55, 19)):   # the run: edge, middle
        rowed(box((3.1, 0.1, z1 - z0), (-1.85, 0.05, (z0 + z1) / 2), 'sky'), row)
    box((0.14, 0.13, 0.9), (-0.55, 0.075, 0.0), 'white')                          # the riffle
    for sz in (-1, 1):                                                           # a few rounded stones
        for k, (x, r) in enumerate(((-3.0, 0.42), (-1.75, 0.36), (-0.8, 0.38))):
            rowed(sphere(r, (x, 0.06, sz * (0.88 + 0.07 * (k % 2))), 'grey', scale=(1.35, 0.4, 0.8), yaw=0.4 * k), 20)
        # a flat pebble out on the grass, where the footprint ends
        rowed(sphere(0.44, (-1.85, 0.02, sz * 1.42), 'grey', scale=(1.0, 0.18, 1.0), yaw=0.5), 12)
    rowed(sphere(0.5, (-0.22, 0.1, 0.0), 'grey', scale=(0.6, 0.45, 2.0)), 20)       # the lip
    box((0.08, 0.16, 0.8), (-0.45, 0.1, 0.0), 0x2a2735)                           # the drain's mouth
    join_still('drain')

# A spring pool, a pond's water drawn in the piece: a ragged outline and four
# bands of the pond's blues (buildPonds: a pale rim, deepening to the middle),
# the deep middle off toward `deep` (where the water comes in), a band of
# pebbles round the side toward +X except a gap at z 0 (`gap`) where the run
# leaves it, and rounded slate boulders on the uphill side (-X). Laid flat at
# the piece's y 0, for a DRAPED group.
def spring_pool(cx, cz, R, deep=(-1.0, 0.0), gap=1.5, stones=True):
    N = 10
    def ring(k, f):
        ox, oz = cx + deep[0] * R * 0.12 * k, cz + deep[1] * R * 0.12 * k
        pts = []
        for j in range(N):
            a = 2 * math.pi * j / N
            r = R * f * (1 + 0.12 * math.sin(3 * a + 1.3) + 0.07 * math.sin(5 * a + 0.4))
            pts.append((ox + r * math.cos(a), oz + r * math.sin(a)))
        return pts
    BANDS = ((1.0, 3), (0.78, 18), (0.56, 26), (0.34, 30))     # (size, the sky ramp's row)
    rings = [ring(k, f) for k, (f, _) in enumerate(BANDS)]
    Y = 0.08
    for k in range(len(BANDS)):
        o_, i_ = rings[k], rings[k + 1] if k + 1 < len(BANDS) else None
        if i_ is None:
            verts = [(x, Y, z) for x, z in o_] + [(sum(p[0] for p in o_) / N, Y, sum(p[1] for p in o_) / N)]
            faces = [(j, (j + 1) % N, N) for j in range(N)]
        else:
            verts = [(x, Y, z) for x, z in o_] + [(x, Y, z) for x, z in i_]
            faces = [(j, (j + 1) % N, N + (j + 1) % N, N + j) for j in range(N)]
        rowed(skin(verts, faces, 'sky', (0, 1, 0)), BANDS[k][1])
    # the pebbles: the rim pushed out 0.7, on the +X half, clear of the gap
    rim = rings[0]
    verts, faces = [], []
    for j in range(N):
        a0, a1 = 2 * math.pi * j / N, 2 * math.pi * (j + 1) / N
        p0, p1 = rim[j], rim[(j + 1) % N]
        if math.cos((a0 + a1) / 2) < 0.2 or (min(p0[1], p1[1]) - cz < gap and max(p0[1], p1[1]) - cz > -gap
                                            and math.cos((a0 + a1) / 2) > 0.8):
            continue
        q = []
        for (x, z) in (p0, p1):
            dx, dz = x - cx, z - cz
            d = math.hypot(dx, dz) or 1.0
            q.append((x + dx / d * 0.7, z + dz / d * 0.7))
        n = len(verts)
        verts += [(p0[0], Y, p0[1]), (p1[0], Y, p1[1]), (q[1][0], Y, q[1][1]), (q[0][0], Y, q[0][1])]
        faces.append((n, n + 1, n + 2, n + 3))
    if faces:
        rowed(skin(verts, faces, 'cream', (0, 1, 0)), 28)
    if stones:
        for k, (dz, r) in enumerate(((-0.75, 1.0), (0.85, 1.15), (0.1, 0.8))):
            rowed(sphere(r, (cx - R * 0.95 - 0.3 * (k == 2), 0.25, cz + dz * R), 'grey',
                         scale=(1.2, 0.65, 1.0), yaw=0.7 * k), SLATE_ROW)

def heron(x, z, yaw=0.0):
    """A grey heron standing facing +X turned by `yaw` (REAL metres, its
    feet at y 0, for a DRAPED group): long dark legs, a body full at the
    breast and tapering to the tail with darker wings folded on it, an
    S-curved white neck, a black crest with a plume and a long yellow
    dagger of a bill. Side-on, that outline is a heron's and nothing else's.
    One gesture: now and then the neck dips toward the water and comes back up."""
    F = local(x, z, yaw)
    with plain_parts():
        for s in (-1, 1):
            strut(F(0.0, 0.0, 0.14 * s), F(0.05, 1.3, 0.1 * s), 0.12, 'dark')
        cyl(0.44, 1.45, F(0.75, 1.52, 0.0), 'grey', r2=0.14, segs=6, axis='across', yaw=yaw + math.pi)
        for s in (-1, 1):
            rowed(box((1.15, 0.34, 0.1), F(-0.1, 1.58, 0.36 * s), 'grey', yaw=yaw, roll=0.12), 22)
        with animated('anim_drape+sway:a=z:d=-24:p=7:r=0.8#heron', F(0.6, 1.7, 0.0), yaw=yaw):
            pts = ((0.6, 1.7), (0.92, 2.0), (0.66, 2.34), (0.84, 2.66))
            for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                strut(F(ax, ay, 0.0), F(bx, by, 0.0), 0.15, 'white')
            box((0.42, 0.26, 0.22), F(0.96, 2.7, 0.0), 'white', yaw=yaw)
            box((0.36, 0.08, 0.24), F(0.88, 2.85, 0.0), 'dark', yaw=yaw)
            strut(F(0.75, 2.84, 0.0), F(0.3, 2.74, 0.0), 0.07, 'dark')             # the plume
            strut(F(1.12, 2.7, 0.0), F(2.0, 2.62, 0.0), 0.1, 'yellow')            # the bill

def pool_heron(px, pz, R, deg):
    """The heron at a spring pool's edge, `deg` round from its road side
    (+X) toward +Z, facing the water: side-on to a racer going by. Inside
    the pool's DRAPED build."""
    a = math.radians(deg)
    heron(px + (R + 0.35) * math.cos(a), pz + (R + 0.35) * math.sin(a), yaw=math.pi)

# ---- CLOVERLEAF: the park railway by the start straight ------------------------------
# A park's miniature line, a little oval on the lawn inside the top loop
# where the start straight runs past it: its near side three units past the
# straight's kerb, its far side four more in, a halt on the near side with
# people waiting, one train going round (an engine and two open coaches,
# people riding). All of it is seen from the straight, the grid and the
# run to the line. A line round the whole loop lay flat behind the kerb,
# seen from nowhere. World units, real size and a little chunky, in the
# frame of its anchor (tracks.js); its points are the train's path, a
# `drape` chain, so the train rides the lawn as drawn, and the ballast and
# rails drape with it.
# The park railway's line: from a balloon loop by the start straight, under
# the high road between two of its pillars, round the bandstand's mound and
# along the finger lobe's return leg to a second loop by the lake; the train
# runs out and back along it, turning on the loops. Laid in the WORLD
# (scratch geometry; it clears every kerb by 2.7 u and crosses no road at
# grade) and cut into lengths, each its own piece in its own frame along its
# chord, so each piece's box hugs its rails: a piece's box keeps the scatter
# out and holds the verge band down under it, and one box round the whole
# line would do both to half the park. PARK_PATH is the whole circuit in the
# train piece's frame (tracks.js places every one of them).
PARK_ROUTE = {
    'park-rails-a': (
        (-0.461, -7.557), (-0.862, -6.639), (-1.162, -5.684), (-1.342, -4.7), (-1.382, -3.7), (-1.222, -2.715), (-0.836, -1.793), (-0.362, -0.911),
        (0.112, -0.028), (0.496, 0.895), (0.661, 1.88), (0.628, 2.88), (0.469, 3.868), (0.235, 4.841), (-0.025, 5.809), (-0.262, 6.781),
        (-0.46, 7.763),
    ),
    'park-rails-b': (
        (-3.288, -6.471), (-2.451, -5.921), (-1.661, -5.307), (-0.98, -4.575), (-0.51, -3.694), (-0.231, -2.734), (-0.09, -1.743), (-0.059, -0.743),
        (-0.122, 0.257), (-0.274, 1.246), (-0.552, 2.207), (-0.945, 3.128), (-1.4, 4.02), (-1.881, 4.898), (-2.36, 5.777), (-2.811, 6.671),
        (-3.288, 7.552),
    ),
    'park-rails-c': (
        (3.066, -6.948), (2.402, -6.199), (1.731, -5.456), (1.089, -4.687), (0.521, -3.863), (0.102, -2.956), (-0.102, -1.978), (-0.11, -0.978),
        (0.008, 0.016), (0.217, 0.995), (0.491, 1.958), (0.812, 2.907), (1.165, 3.844), (1.543, 4.771), (1.986, 5.669), (2.505, 6.525),
        (3.067, 7.354),
    ),
    'park-rails-d': (
        (-1.004, -7.878), (-0.731, -6.915), (-0.463, -5.95), (-0.224, -4.978), (-0.036, -3.994), (0.079, -3), (0.11, -1.999), (0.083, -0.998),
        (0.011, 0.001), (-0.089, 0.997), (-0.211, 1.991), (-0.347, 2.983), (-0.489, 3.974), (-0.631, 4.966), (-0.764, 5.958), (-0.881, 6.953),
        (-1.004, 7.947),
    ),
    'park-rails-e': (
        (1.182, -6.007), (0.97, -5.028), (0.749, -4.052), (0.531, -3.074), (0.327, -2.094), (0.158, -1.107), (0.049, -0.112), (0.057, 0.889),
        (0.213, 1.877), (0.485, 2.84), (0.834, 3.779), (1.182, 4.717),
    ),
    'park-rails-loop-a': (
        (-0.03, -5.516), (-0.473, -4.637), (-0.916, -3.757), (-1.359, -2.878), (-1.802, -1.999), (-2.245, -1.119), (-2.688, -0.24), (-3.069, 0.666),
        (-3.183, 1.638), (-2.998, 2.6), (-2.531, 3.461), (-1.826, 4.14), (-0.947, 4.575), (0.023, 4.724), (0.991, 4.565), (1.865, 4.121),
        (2.564, 3.434), (3.022, 2.569), (3.197, 1.605), (3.072, 0.634), (2.683, -0.268), (2.231, -1.142), (1.778, -2.017), (1.326, -2.892),
        (0.874, -3.767), (0.422, -4.641), (-0.03, -5.516),
    ),
    'park-rails-loop-b': (
        (4.818, 5.584), (4.558, 4.63), (4.298, 3.676), (4.039, 2.723), (3.779, 1.769), (3.52, 0.815), (3.26, -0.138), (3.001, -1.092),
        (2.741, -2.046), (2.428, -2.982), (1.915, -3.823), (1.224, -4.525), (0.391, -5.052), (-0.546, -5.356), (-1.526, -5.447), (-2.501, -5.299),
        (-3.412, -4.927), (-4.221, -4.363), (-4.86, -3.612), (-5.317, -2.74), (-5.557, -1.784), (-5.561, -0.799), (-5.347, 0.162), (-4.901, 1.042),
        (-4.269, 1.796), (-3.481, 2.388), (-2.579, 2.788), (-1.654, 3.138), (-0.73, 3.487), (0.195, 3.837), (1.119, 4.186), (2.044, 4.535),
        (2.969, 4.885), (3.893, 5.234), (4.818, 5.584),
    ),
}
PARK_PATH = (
        (0.388, -8.032), (0.334, -7.032), (0.279, -6.032), (0.226, -5.032), (0.176, -4.032), (0.132, -3.031), (0.087, -2.031), (0.041, -1.031),
        (0, -0.03), (-0.03, 0.971), (-0.041, 1.972), (-0.04, 2.974), (-0.057, 3.975), (-0.064, 4.977), (-0.023, 5.977), (0.113, 6.969),
        (0.388, 7.931), (0.767, 8.857), (1.243, 9.737), (1.824, 10.552), (2.513, 11.277), (3.331, 11.849), (4.262, 12.215), (5.225, 12.489),
        (6.188, 12.764), (7.118, 13.132), (7.94, 13.699), (8.634, 14.419), (9.232, 15.222), (9.767, 16.068), (10.28, 16.928), (10.813, 17.776),
        (11.379, 18.602), (11.933, 19.436), (12.419, 20.311), (12.758, 21.251), (12.845, 22.246), (12.726, 23.239), (12.466, 24.205), (12.103, 25.138),
        (11.654, 26.032), (11.126, 26.883), (10.494, 27.658), (9.771, 28.351), (9.003, 28.993), (8.215, 29.612), (7.43, 30.234), (6.665, 30.879),
        (5.881, 31.502), (5.06, 32.076), (4.234, 32.641), (3.431, 33.239), (2.686, 33.908), (2.067, 34.692), (1.64, 35.595), (1.399, 36.566),
        (1.282, 37.56), (1.256, 38.561), (1.298, 39.561), (1.388, 40.558), (1.513, 41.552), (1.664, 42.542), (1.885, 43.518), (2.19, 44.472),
        (2.543, 45.409), (2.916, 46.338), (3.285, 47.269), (3.626, 48.211), (3.917, 49.169), (4.136, 50.145), (4.274, 51.137), (4.353, 52.135),
        (4.387, 53.136), (4.393, 54.137), (4.378, 55.139), (4.348, 56.14), (4.311, 57.14), (4.275, 58.141), (4.248, 59.142), (4.238, 60.144),
        (4.221, 61.145), (4.185, 62.146), (4.141, 63.146), (4.098, 64.147), (4.072, 65.148), (4.08, 66.149), (4.149, 67.148), (4.334, 68.131),
        (4.662, 69.076), (5.101, 69.976), (5.611, 70.838), (6.12, 71.699), (6.181, 72.686), (6.242, 73.672), (6.303, 74.659), (6.364, 75.645),
        (6.425, 76.632), (6.486, 77.618), (6.547, 78.605), (6.608, 79.591), (6.725, 80.571), (7.057, 81.499), (7.591, 82.326), (8.3, 83.011),
        (9.156, 83.499), (10.098, 83.786), (11.082, 83.839), (12.05, 83.659), (12.956, 83.271), (13.734, 82.665), (14.358, 81.903), (14.787, 81.016),
        (14.99, 80.052), (14.976, 79.067), (14.717, 78.116), (14.251, 77.249), (13.598, 76.51), (12.796, 75.935), (11.962, 75.405), (11.127, 74.876),
        (10.293, 74.347), (9.458, 73.817), (8.623, 73.288), (7.789, 72.758), (6.954, 72.229), (6.12, 71.699), (5.611, 70.838), (5.101, 69.976),
        (4.662, 69.076), (4.334, 68.131), (4.149, 67.148), (4.08, 66.149), (4.072, 65.148), (4.098, 64.147), (4.141, 63.146), (4.185, 62.146),
        (4.221, 61.145), (4.238, 60.144), (4.248, 59.142), (4.275, 58.141), (4.311, 57.14), (4.348, 56.14), (4.378, 55.139), (4.393, 54.137),
        (4.387, 53.136), (4.353, 52.135), (4.274, 51.137), (4.136, 50.145), (3.917, 49.169), (3.626, 48.211), (3.285, 47.269), (2.916, 46.338),
        (2.543, 45.409), (2.19, 44.472), (1.885, 43.518), (1.664, 42.542), (1.513, 41.552), (1.388, 40.558), (1.298, 39.561), (1.256, 38.561),
        (1.282, 37.56), (1.399, 36.566), (1.64, 35.595), (2.067, 34.692), (2.686, 33.908), (3.431, 33.239), (4.234, 32.641), (5.06, 32.076),
        (5.881, 31.502), (6.665, 30.879), (7.43, 30.234), (8.215, 29.612), (9.003, 28.993), (9.771, 28.351), (10.494, 27.658), (11.126, 26.883),
        (11.654, 26.032), (12.103, 25.138), (12.466, 24.205), (12.726, 23.239), (12.845, 22.246), (12.758, 21.251), (12.419, 20.311), (11.933, 19.436),
        (11.379, 18.602), (10.813, 17.776), (10.28, 16.928), (9.767, 16.068), (9.232, 15.222), (8.634, 14.419), (7.94, 13.699), (7.118, 13.132),
        (6.188, 12.764), (5.225, 12.489), (4.262, 12.215), (3.331, 11.849), (2.513, 11.277), (1.824, 10.552), (1.243, 9.737), (0.767, 8.857),
        (0.388, 7.931), (0.113, 6.969), (-0.023, 5.977), (-0.064, 4.977), (-0.057, 3.975), (-0.04, 2.974), (-0.041, 1.972), (-0.03, 0.971),
        (0, -0.03), (0.041, -1.031), (0.087, -2.031), (0.132, -3.031), (0.176, -4.032), (0.226, -5.032), (0.279, -6.032), (0.334, -7.032),
        (0.388, -8.032), (0.882, -8.884), (1.377, -9.735), (1.871, -10.587), (2.366, -11.438), (2.86, -12.29), (3.355, -13.141), (3.788, -14.022),
        (3.961, -14.987), (3.833, -15.957), (3.418, -16.844), (2.754, -17.565), (1.903, -18.051), (0.944, -18.257), (-0.032, -18.156), (-0.931, -17.765),
        (-1.67, -17.121), (-2.178, -16.284), (-2.41, -15.333), (-2.344, -14.356), (-2.008, -13.433), (-1.609, -12.533), (-1.21, -11.632), (-0.81, -10.732),
        (-0.411, -9.832), (-0.012, -8.932),
)
PARK_HOME = (
        (0.388, -8.032), (0.334, -7.032), (0.279, -6.032), (0.226, -5.032), (0.176, -4.032), (0.132, -3.031), (0.087, -2.031), (0.041, -1.031),
        (0, -0.03), (-0.03, 0.971), (-0.041, 1.972), (-0.04, 2.974), (-0.057, 3.975), (-0.064, 4.977), (-0.023, 5.977), (0.113, 6.969),
        (0.388, 7.931),
)

def park_wheels(x, y, z, k, xs, r, half):
    """A pair of wheels at each of `xs` along the frame: dark tyres, a red
    centre, the axle through; `half` the body's half width."""
    for dx in xs:
        for s in (-1, 1):
            z0 = z + s * half - (0.07 * k if s < 0 else 0.0)
            cyl(r * k, 0.07 * k, (x + dx * k, y + r * k, z0), 'dark', segs=10, axis='along')
            box((r * 0.7 * k, r * 0.7 * k, 0.03 * k), (x + dx * k, y + r * k, z + s * (half + 0.075 * k)), 'red')

def park_engine(at, k=1.0, boiler='red', cab='green'):
    """A little tank engine facing +X on the rails at `at`: six wheels and
    their coupling rod, the footplate, a round boiler with its dome and
    chimney ahead, the cab with its roof and windows behind, buffers and a
    lamp."""
    x, y, z = at
    park_wheels(x, y, z, k, (-0.5, 0.0, 0.5), 0.16, 0.26 * k)
    for s in (-1, 1):
        box((1.1 * k, 0.05 * k, 0.03 * k), (x, y + 0.13 * k, z + s * 0.37 * k), 'grey')        # the coupling rod
    box((1.6 * k, 0.1 * k, 0.6 * k), (x, y + 0.34 * k, z), 'dark')                             # the footplate
    cyl(0.25 * k, 0.9 * k, (x - 0.2 * k, y + 0.64 * k, z), boiler, segs=10, axis='across', smooth=True)
    cyl(0.26 * k, 0.08 * k, (x + 0.7 * k, y + 0.64 * k, z), 'dark', segs=10, axis='across')    # the smokebox door
    cyl(0.09 * k, 0.3 * k, (x + 0.55 * k, y + 0.85 * k, z), 'dark', r2=0.12 * k, segs=8)       # the chimney
    cyl(0.1 * k, 0.14 * k, (x + 0.2 * k, y + 0.86 * k, z), 'yellow', segs=8)                   # the dome
    box((0.5 * k, 0.62 * k, 0.6 * k), (x - 0.5 * k, y + 0.7 * k, z), cab)
    box((0.62 * k, 0.07 * k, 0.7 * k), (x - 0.5 * k, y + 1.04 * k, z), 'dark')
    for s in (-1, 1):
        box((0.26 * k, 0.2 * k, 0.02 * k), (x - 0.5 * k, y + 0.85 * k, z + s * 0.305 * k), 'sky')  # the cab's windows
    box((0.06 * k, 0.12 * k, 0.6 * k), (x + 0.82 * k, y + 0.34 * k, z), 'red')                 # the buffer beam
    box((0.1 * k, 0.1 * k, 0.1 * k), (x + 0.78 * k, y + 0.95 * k, z), 'yellow')                # the lamp

def park_coach(at, color, riders, k=1.0):
    """An open coach facing +X: four wheels, a low panelled body with its
    seat backs, and two people sitting in it, riding (they keep still: the
    coach moves them)."""
    x, y, z = at
    park_wheels(x, y, z, k, (-0.42, 0.42), 0.14, 0.24 * k)
    box((1.4 * k, 0.08 * k, 0.54 * k), (x, y + 0.3 * k, z), 'dark')
    box((1.35 * k, 0.26 * k, 0.6 * k), (x, y + 0.47 * k, z), color)
    box((1.37 * k, 0.05 * k, 0.62 * k), (x, y + 0.6 * k, z), 'white')                          # the body's rail
    for n, shirt in enumerate(riders):
        dx = (0.33 - 0.66 * n) * k
        box((0.05 * k, 0.3 * k, 0.5 * k), (x + dx - 0.16 * k, y + 0.72 * k, z), 0x9a7b55)      # the seat's back
        box((0.2 * k, 0.24 * k, 0.24 * k), (x + dx, y + 0.72 * k, z), shirt)
        box((0.15 * k, 0.15 * k, 0.15 * k), (x + dx, y + 0.92 * k, z), 0xf2bf99)

def park_waiting(at, yaw, shirt):
    """Someone standing on the platform waiting for the train, still: legs,
    body, head, at a person's size beside a car."""
    x, y, z = at
    box((0.14, 0.24, 0.18), (x, y + 0.12, z), 0x4f5260, yaw=yaw)
    box((0.18, 0.22, 0.24), (x, y + 0.35, z), shirt, yaw=yaw)
    box((0.14, 0.14, 0.14), (x, y + 0.53, z), 0xf2bf99, yaw=yaw)

def park_track(pts):
    """The line along `pts`: a ballast bank, a sleeper every unit and two
    rails, each one band (a dozen vertices a unit of track)."""
    n = len(pts)
    closed = math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < 0.01
    if closed:
        pts, n = pts[:-1], n - 1
    def frame(i):
        a = pts[(i - 1) % n] if closed else pts[max(0, i - 1)]
        b = pts[(i + 1) % n] if closed else pts[min(n - 1, i + 1)]
        tx, tz = b[0] - a[0], b[1] - a[1]
        d = math.hypot(tx, tz)
        return tx / d, tz / d
    def band(profile, color):
        m = len(profile)
        verts, faces = [], []
        for i, (x, z) in enumerate(pts):
            tx, tz = frame(i)
            for o, y in profile:
                verts.append((x + tz * o, y, z - tx * o))
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            for c in range(m - 1):
                faces.append((m * i + c, m * j + c, m * j + c + 1, m * i + c + 1))
        o = ground_poly(verts, faces, color)
        for f in o.data.polygons:                              # one normal a corner: no seam per face
            f.use_smooth = True
    band(((0.85, 0.0), (0.55, 0.15), (-0.55, 0.15), (-0.85, 0.0)), 'lavender')  # the ballast bank
    verts, faces = [], []
    for i, (x, z) in enumerate(pts):
        tx, tz = frame(i)
        for a, o in ((-0.11, 0.48), (0.11, 0.48), (0.11, -0.48), (-0.11, -0.48)):
            verts.append((x + tx * a + tz * o, 0.17, z + tz * a - tx * o))
        faces.append(tuple(range(4 * i, 4 * i + 4)))
    ground_poly(verts, faces, 'brown')
    for sd in (-1, 1):
        band(((sd * 0.27 + 0.05, PARK_RAIL_Y), (sd * 0.27 - 0.05, PARK_RAIL_Y)), 'slate')

PARK_RAIL_Y = 0.2                                                 # the rails' top

for _name, _pts in PARK_ROUTE.items():
    PIECES[_name] = (lambda pts: lambda: (park_track(pts), join_still('drape_line')))(_pts)
    GROW[_name] = 1.0

def park_platform(side):
    """A halt beside the line through the origin along Z, on its `side`: a
    platform, a shelter open to the line, a lamp, two people waiting."""
    PX = side * 1.45
    box((0.9, 0.3, 3.6), (PX, 0.15, 0.0), 'cream')
    box((0.12, 0.75, 1.5), (PX + side * 0.35, 0.6, -0.5), 'red')              # the shelter's back
    for sz in (-1, 1):
        box((0.6, 0.75, 0.1), (PX + side * 0.08, 0.6, -0.5 + sz * 0.7), 'red')
    box((0.85, 0.1, 1.75), (PX + side * 0.05, 1.02, -0.5), 'dark')            # its roof
    box((0.06, 1.1, 0.06), (PX + side * 0.3, 0.85, 1.5), 'dark')              # the lamp
    box((0.16, 0.16, 0.16), (PX + side * 0.3, 1.45, 1.5), 'white')
    park_waiting((PX - side * 0.15, 0.3, 0.8), 0.0, 0x339cf2)
    park_waiting((PX - side * 0.05, 0.3, 1.25), 0.4, 0xffc044)

@piece()
def park_railway():
    # The train, its home halt by the start straight and the home stretch of
    # the line. The rest of the rails are the park-rails pieces; this one
    # carries the path the train rides (the whole circuit, draped onto the
    # land).
    pts, n = PARK_PATH, len(PARK_PATH)
    park_track(PARK_HOME)                # the home stretch, the train standing on its end
    park_platform(1)
    Y = PARK_RAIL_Y
    for i, (x, z) in enumerate(pts):
        marker('path_drapetrain_%d' % i, (x, Y, z))
    span = sum(math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) for i in range(n))
    period = span / 3.0                                           # 3 u a second
    K = 1.4                                                       # a little chunky
    # one train (the line is single): an engine and three open coaches
    cars = [(1.5 * K, lambda at: park_engine(at, K, 'red', 'green'))]
    cars += [(1.35 * K, lambda at, c=c, r=r: park_coach(at, c, r, K))
             for c, r in (('blue', (0xff5040, 0xffc044)), ('yellow', (0x22c46e, 0xa878e8)), ('red', (0x339cf2, 0xf8f8fb)))]
    x0, z0 = pts[0]
    behind = 0.0
    for c, (L, build) in enumerate(cars):
        if c:
            behind += (cars[c - 1][0] + L) / 2 + 0.15 * K
        with animated('anim_path:c=drapetrain:p=%.2f:o=%.4f:f=1#%d' % (period, (1.0 - behind / span) % 1.0, c), (x0, Y, z0)):
            build((x0, Y, z0))
    join_still('drape_line')

@piece()
def park_halt():
    # The lake halt, beside the line where it comes to the lake. It DRAPES.
    park_platform(-1)
    join_still('drape_halt')

# ---- CLOVERLEAF: the playground on the hill -----------------------------------------
# Cloverleaf's playground at the size of a real one, on the broad top of its
# hill (SET_GROUND, built from the summit and lifted onto it): a climbing tower
# with a slide off it, the rope climbing net standing over the rest, swings, a
# seesaw, a roundabout and a spring rider, every one with a child on it and
# moving, a sandpit, the mums and dads on the benches.

def kid_swing(n, x, z, top, shirt, hair):
    with animated('anim_sway:a=z:d=32:p=%.1f#%d' % (2.3 + 0.25 * n, n), (x, top, z)):
        for s in (-1, 1):
            strut((x, top - 0.05, z + s * 0.32), (x, 0.62, z + s * 0.32), 0.07, 0x9aa1b4)
        box((0.55, 0.1, 0.75), (x, 0.58, z), 0xff5040)
        person((x - 0.1, 0.63, z), 0.0, shirt, k=0.68, hair=hair, sit=True, arm=1.3)

def slide_tower(TX, TZ, DY=1.6):
    """A climbing tower: a deck on four posts under a red roof, a slide off
    its +X side, a ladder up its back."""
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((0.24, 3.4, 0.24), (TX + sx * 1.0, 1.7, TZ + sz * 1.0), 0xffc044)
    box((2.4, 0.2, 2.4), (TX, DY, TZ), 0x9a7b55)
    for sz in (-1, 1):
        box((2.2, 0.8, 0.12), (TX, DY + 0.5, TZ + sz * 1.05), 0x339cf2)
    box((2.8, 0.16, 1.7), (TX, 3.65, TZ - 0.55), 0xff5040, roll=0.0, pitch=0.6)
    box((2.8, 0.16, 1.7), (TX, 3.65, TZ + 0.55), 0xff5040, pitch=-0.6)
    a = math.atan2(DY - 0.3, 3.6)
    for s in (-1, 1):
        box((3.9, 0.3, 0.12), (TX + 1.1 + 1.8, (DY + 0.3) / 2 + 0.12, TZ + s * 0.45), 0xff5040, roll=a)
    box((3.9, 0.1, 0.9), (TX + 1.1 + 1.8, (DY + 0.3) / 2, TZ), 0xff5040, roll=a)
    for s in (-1, 1):
        strut((TX - 2.2, 0, TZ + s * 0.4), (TX - 1.0, DY, TZ + s * 0.4), 0.12, 0x9aa1b4)
    for i in range(4):
        t = (i + 0.7) / 4.5
        box((0.12, 0.1, 0.8), (TX - 2.2 + 1.2 * t, DY * t, TZ), 0x9aa1b4)

def climbing_net(NX, NZ, NH=7.0, NR=2.6):
    """The climbing net: a rope pyramid on a mast, the tallest thing in a
    park as it is in a real one (about seven metres)."""
    cyl(0.16, NH, (NX, 0, NZ), 0x9aa1b4, segs=6)
    box((0.5, 0.3, 0.5), (NX, NH + 0.1, NZ), 0xff5040)
    ring = [(NX + NR * math.cos(k * math.pi / 4), NZ + NR * math.sin(k * math.pi / 4)) for k in range(8)]
    for x, z in ring:
        strut((x, 0.05, z), (NX, NH, NZ), 0.16, 0xff5040)
    for f in (0.33, 0.66):
        for k in range(8):
            (x0, z0), (x1, z1) = ring[k], ring[(k + 1) % 8]
            strut((NX + (x0 - NX) * (1 - f), NH * f, NZ + (z0 - NZ) * (1 - f)),
                  (NX + (x1 - NX) * (1 - f), NH * f, NZ + (z1 - NZ) * (1 - f)), 0.12, 0xff5040)

@piece(REAL)
def playground():
    # On the flat at the hill's foot, by the hairpin's outside: up on the
    # hill's top it stood a grid cell and more off the road (the deck's cap
    # holds the land down nearer than that) and read as a dot.
    s0 = 0.0
    # the swings: an A-frame each end of a top bar along Z
    SX, top = -5.0, 2.6
    for z in (-9.0, -3.0):
        for s in (-1, 1):
            strut((SX + s * 1.3, 0, z), (SX, top, z), 0.2, 0x339cf2)
    box((0.24, 0.24, 6.4), (SX, top, -6.0), 0x339cf2)
    kid_swing(0, SX, -7.4, top, 0xffc044, 1)
    kid_swing(1, SX, -4.6, top, 0x22c46e, 2)
    # the climbing tower, its slide off the road side (+X)
    TX, TZ, DY = 1.5, 5.0, 1.6
    slide_tower(TX, TZ)
    person((TX + 0.3, DY + 0.1, TZ - 0.3), 0.3, 0xa259e6, k=0.68, hair=3)
    # the seesaw, a child each end
    QX, QZ = 6.0, -2.0
    box((0.4, 0.6, 0.5), (QX, 0.3, QZ), 0x339cf2)
    with animated('anim_sway:a=x:d=12:p=2.6', (QX, 0.65, QZ)):
        box((0.35, 0.12, 4.4), (QX, 0.65, QZ), 0x22c46e)
        for s in (-1, 1):
            box((0.12, 0.45, 0.12), (QX, 0.92, QZ + s * 1.55), 0x9aa1b4)
            person((QX, 0.71, QZ + s * 1.95), (math.pi / 2 if s > 0 else -math.pi / 2), (0xff5040, 0x339cf2)[s > 0],
                   k=0.66, hair=s + 1, sit=True, arm=1.0)
    # the roundabout turning, two children riding it
    RX, RZ = 2.0, -6.5
    box((0.6, 0.3, 0.6), (RX, 0.15, RZ), 0x9aa1b4)
    with animated('anim_spin:w=1.2', (RX, 0.3, RZ)):
        cyl(1.25, 0.16, (RX, 0.3, RZ), 0xffc044, segs=12)
        cyl(0.12, 1.0, (RX, 0.46, RZ), 0x9aa1b4, segs=6)
        for k in range(4):
            a = k * math.pi / 2
            strut((RX, 1.4, RZ), (RX + math.cos(a) * 1.05, 0.95, RZ + math.sin(a) * 1.05), 0.1, 0xff5040)
            box((0.1, 0.5, 0.1), (RX + math.cos(a) * 1.05, 0.7, RZ + math.sin(a) * 1.05), 0xff5040)
        for k, c in ((0, 0xf8f8fb), (2, 0x22c46e)):
            a = k * math.pi / 2 + math.pi / 4
            person((RX + math.cos(a) * 0.75, 0.46, RZ + math.sin(a) * 0.75), -a + math.pi, c, k=0.66, hair=k, sit=True)
    # the spring rider, rocking
    with animated('anim_sway:a=z:d=18:p=0.9', (-1.5, 0.1, 1.0)):
        box((0.2, 0.7, 0.2), (-1.5, 0.35, 1.0), 0x2a2735)
        box((1.1, 0.5, 0.45), (-1.5, 0.95, 1.0), 0x22c46e)
        box((0.35, 0.5, 0.35), (-1.0, 1.35, 1.0), 0x22c46e)
        person((-1.6, 1.15, 1.0), 0.0, 0xff5040, k=0.6, hair=2, sit=True, arm=1.2)
    # the sandpit, a child in it digging
    for s in (-1, 1):
        box((3.6, 0.3, 0.25), (-5.5, 0.15, 5.0 + s * 1.7), 0x9a7b55)
        box((0.25, 0.3, 3.6), (-5.5 + s * 1.7, 0.15, 5.0), 0x9a7b55)
    box((3.2, 0.24, 3.2), (-5.5, 0.12, 5.0), 0xfde4c7)
    person((-5.6, 0.2, 5.3), 0.4, 0x339cf2, k=0.6, hair=0)
    box((0.4, 0.4, 0.4), (-4.9, 0.4, 4.4), 0xff5040)
    # the climbing net, two children up it
    NX, NZ, NH = -2.0, 8.6, 7.0
    climbing_net(NX, NZ)
    person((NX + 1.3, NH * 0.33 + 0.05, NZ - 1.4), 2.3, 0x22c46e, k=0.62, hair=1, arm=2.4)
    person((NX - 0.6, NH * 0.66 + 0.05, NZ + 0.5), 0.9, 0xffc044, k=0.6, hair=2, arm=2.6)
    # the benches round it, two of the grown-ups watching
    for z, c in ((-3.0, 0xa259e6), (6.5, 0xffc044)):
        bench((-8.4, 0, z), yaw=math.pi / 2)
        person((-8.5, 0.5, z + 0.2), 0.0, c, hair=1 if z < 0 else 3, sit=True)
    # the ice-cream van up on the hill at the end of the swings, its hatch to
    # the road and the children queueing at it: part of the scene a racer
    # reads as one shape, where on its own at the hill's foot it was a car's
    # size under the kerb (and no nearer the road, where the land a deck
    # holds down falls away under it)
    ice_cream_van(4.0, -15.0)
    # its ground: a bark-chip pad under the equipment, a low timber fence
    # round it with the gate to the road, and the path out to the van
    HX, Z0, Z1 = 10.0, -11.5, 13.0
    ground_poly([(-HX, 0.05, Z0), (HX, 0.05, Z0), (HX, 0.05, Z1), (-HX, 0.05, Z1)], [(0, 3, 2, 1)], 'gravel')['ramp'] = 0.5
    ground_poly([(2.5, 0.05, -18.5), (5.5, 0.05, -18.5), (5.5, 0.05, Z0), (2.5, 0.05, Z0)], [(0, 3, 2, 1)], 'gravel')['ramp'] = 0.15
    ring = [(-HX, Z0), (-HX, Z1), (HX, Z1), (HX, Z0), (-HX, Z0)]
    for (x0, z0), (x1, z1) in zip(ring, ring[1:]):
        n = max(1, round(math.hypot(x1 - x0, z1 - z0) / 4.0))
        for q in range(n):
            a = (x0 + (x1 - x0) * q / n, 0.0, z0 + (z1 - z0) * q / n)
            b = (x0 + (x1 - x0) * (q + 1) / n, 0.0, z0 + (z1 - z0) * (q + 1) / n)
            if x0 == HX and x1 == HX and abs((a[2] + b[2]) / 2) < 2.5:
                continue                                  # the gate, to the road
            if z0 == Z0 and z1 == Z0 and 2.0 < (a[0] + b[0]) / 2 < 6.0:
                continue                                  # and the path to the van
            post_and_rail(a, b, 1.0, 0x9a7b55, r=0.1)
    for o in bpy.context.scene.objects:          # onto the summit
        o.location.z += s0
    ANIMS[:] = [(n, (x, y + s0, z), yaw, p, t) for n, (x, y, z), yaw, p, t in ANIMS]
    join_still('playground')

@piece(REAL)
def play_corner():
    # Another corner of the same park on the flat by the road, so the
    # playground's afternoon reaches round the lap: the climbing net
    # standing over a slide tower, its slide toward the road (+X), a pair of
    # swings going, a grown-up on the bench.
    climbing_net(-2.5, 2.5)
    slide_tower(1.0, -3.0)
    person((1.3, 1.7, -3.3), 0.3, 0xff5040, k=0.68, hair=1)
    person((-1.2, 7.0 * 0.5 + 0.05, 2.9), 0.9, 0x339cf2, k=0.62, hair=2, arm=2.6)
    SX, top = -4.0, 2.6
    for z in (-6.0, -1.6):
        for k in (-1, 1):
            strut((SX + k * 1.3, 0, z), (SX, top, z), 0.2, 0x22c46e)
    box((0.24, 0.24, 4.8), (SX, top, -3.8), 0x22c46e)
    kid_swing(2, SX, -4.9, top, 0xa259e6, 3)
    kid_swing(3, SX, -2.7, top, 0xffc044, 0)
    bench((-5.2, 0, 4.5), yaw=math.pi / 2)
    person((-5.3, 0.5, 4.7), 0.0, 0x22c46e, hair=2, sit=True)
    join_still('corner')

def ice_cream_van(ox, oz):
    """The park's ice-cream van parked at (ox, oz) of the piece's frame: a van
    along a gravel lay-by (its length Z, the serving hatch on +X) under the
    big cone on its roof turning, the children queueing at the hatch, one
    waving, a grown-up on the bench with a cone. Real size: about one and a
    half cars long. Built at the origin, then moved there."""
    before, n = set(bpy.context.scene.objects), len(ANIMS)
    BODY, TRIM = 0xf8f8fb, 0x339cf2
    box((4.6, 0.1, 9.0), (1.2, 0.05, 0.0), 0xfde4c7)                 # the lay-by
    box((2.3, 1.3, 6.2), (0, 1.15, -0.2), BODY)                       # the body
    box((2.32, 0.3, 6.22), (0, 0.65, -0.2), TRIM)                     # its skirt
    box((2.3, 1.5, 4.4), (0, 2.55, -1.1), BODY)                       # the box behind the cab
    box((2.32, 0.28, 4.42), (0, 2.0, -1.1), TRIM)                     # the stripe round it
    # the cab: a square box lower than the body behind it, an upright
    # windscreen over a short bonnet, door windows, mirrors, a grille
    box((2.2, 1.2, 1.3), (0, 2.4, 1.75), BODY)
    box((2.24, 0.1, 1.34), (0, 3.02, 1.75), TRIM)                     # its roof's edge
    box((1.9, 0.72, 0.1), (0, 2.5, 2.42), 0x2f5f9f)                   # the windscreen
    box((1.6, 0.5, 0.08), (0, 1.3, 2.92), 'grey')                     # the grille
    box((2.3, 0.22, 0.3), (0, 0.62, 2.98), 'grey')                    # the bumper
    for s in (-1, 1):
        box((0.36, 0.3, 0.1), (s * 0.85, 1.3, 2.93), 0xffc044)        # the lamps
        box((0.08, 0.62, 0.8), (s * 1.12, 2.5, 1.8), 0x2f5f9f)        # the door windows
        box((0.3, 0.26, 0.1), (s * 1.3, 2.25, 2.35), 'dark')          # the mirrors
    for sz in (-2.1, 1.8):
        for x in (1.0, -1.4):
            cyl(0.5, 0.4, (x, 0.5, sz), 0x2a2735, segs=8, axis='across')
    # the serving hatch, its awning out over the queue, the menu under it
    box((0.12, 0.95, 2.4), (1.16, 2.55, -1.3), 0x2a2735)
    box((0.9, 0.1, 2.8), (1.55, 3.2, -1.3), 0xff5040, roll=-0.35)
    box((0.1, 0.5, 1.6), (1.18, 1.5, -1.3), 0xffc044)
    # the cone on the roof, turning: the wafer and two scoops
    with animated('anim_spin:w=1.1', (0, 3.3, -1.1)):
        cyl(0.12, 1.3, (0, 3.3, -1.1), 0xd9b054, r2=0.55, segs=8)
        sphere(0.62, (0, 4.85, -1.1), 0xf1976c)
        sphere(0.45, (0, 5.5, -1.1), 0xfde4c7)
    # the queue at the hatch, facing it, the second child's arms going up
    person((2.3, 0, -1.6), math.pi, 0xff5040, k=0.68, hair=1, arm=0.6)
    person((3.0, 0, -0.4), math.pi * 0.9, 0x22c46e, k=0.64, hair=2, arm=0.3,
           gesture='anim_sway:a=z:d=140:p=3.2:r=0.65#kid')
    person((3.4, 0, 0.8), math.pi * 0.85, 0xa259e6, k=0.7, hair=3)
    person((3.7, 0, 1.9), math.pi * 0.85, 0x339cf2, hair=0)
    # the bench along the back of the lay-by, a grown-up with a cone
    bench((3.4, 0, -3.6), yaw=-math.pi / 2)
    person((3.5, 0.5, -3.6), math.pi, 0xffc044, hair=3, sit=True, arm=1.0)
    for o in bpy.context.scene.objects:
        if o not in before:
            o.location.x += ox
            o.location.y -= oz
    ANIMS[n:] = [(nm, (x + ox, y, z + oz), yaw, p, t) for nm, (x, y, z), yaw, p, t in ANIMS[n:]]

# ====================================================================================
# CANYON
# ====================================================================================

TIMBER, BONE, ROPE = 0x8a5f3e, 0xf8f8fb, 0x2a2735

class plain_parts:
    """The parts built inside stay square-edged. At a real thing's size a
    post, a rail, a cow's leg is a few hundredths of a unit across, where
    the chamfer cannot be seen and only multiplies the part's triangles by
    almost four; the same holds for rough rock, whose blocks are big but
    whose edges no one reads as made. The chamfer is also what the bake
    simplifies away for a piece's FAR form, though (TtpRenderer::farForm
    keeps none that cuts less than a fifth): a piece that is square all
    through draws whole at any distance, so square its small parts and keep
    its frame chamfered."""
    def __enter__(self):
        self.before = set(bpy.context.scene.objects)
        return self
    def __exit__(self, *exc):
        for o in bpy.context.scene.objects:
            if o not in self.before:
                o['chamfer'] = 0
        return False

def plain(fn):
    """A builder whose every part is built inside plain_parts."""
    def build():
        with plain_parts():
            fn()
    build.__name__ = fn.__name__
    return build

def footbridge(at, span=4.0, w=1.6):
    """Timber planks over a creek, crossing ALONG +Z: a stone sill on each bank
    that the deck lands on, a gentle arch between, posts and a rail each side."""
    x, y, z = at
    for sz in (-1, 1):
        box((w + 0.5, 0.36, 0.8), (x, y + 0.18, z + sz * (span / 2 + 0.2)), 'grey')
    n = 9
    for k in range(n):
        t = (k - (n - 1) / 2) / ((n - 1) / 2)
        box((w, 0.12, span / n + 0.02), (x, y + 0.42 + (1 - t * t) * 0.3, z + t * (span / 2 - span / n / 2)),
            TIMBER, pitch=-t * 0.22)
    for sx in (-1, 1):
        for sz in (-1, 0, 1):
            h = 1.15 + (0.3 if sz == 0 else 0.0)
            box((0.16, h, 0.16), (x + sx * (w / 2 + 0.02), y + 0.36 + h / 2 - 0.1, z + sz * (span / 2 - 0.1)), TIMBER)
        for z0, z1 in ((-1, 0), (0, 1)):
            a, b = z + z0 * (span / 2 - 0.1), z + z1 * (span / 2 - 0.1)
            ya, yb = y + 1.4 + (0.3 if z0 == 0 else 0.0), y + 1.4 + (0.3 if z1 == 0 else 0.0)
            L = math.hypot(b - a, yb - ya)
            box((0.12, 0.12, L), (x + sx * (w / 2 + 0.02), (ya + yb) / 2, (a + b) / 2), TIMBER,
                pitch=math.atan2(yb - ya, b - a))

def ore_cart(at, yaw=0.0, ore=True, ore_color=0xa8623f, k=1.0):
    """A mine cart on rails along its local Z, 1.9 long at k 1: a tub
    flaring to its rim on a frame, four spoked wheels' worth of disc under
    it, ore heaped in it."""
    x, y, z = at
    c, sn = math.cos(yaw), math.sin(yaw)
    def at2(dx, dy, dz):
        return (x + (dx * c + dz * sn) * k, y + dy * k, z + (-dx * sn + dz * c) * k)
    lo, hi = ((0.42, 0.62), 0.5), ((0.66, 0.96), 1.22)
    verts = [at2(sx * hx, hy, sz * hz) for (hx, hz), hy in (lo, hi) for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    solid(verts, [(3, 2, 1, 0), (4, 5, 6, 7)] + [(i, (i + 1) % 4, 4 + (i + 1) % 4, 4 + i) for i in range(4)], 'grey')
    box((1.4 * k, 0.1 * k, 2.0 * k), at2(0, 1.25, 0), 'slate', yaw=yaw)                     # the rim
    box((0.86 * k, 0.14 * k, 1.7 * k), at2(0, 0.44, 0), 'slate', yaw=yaw)                   # the frame
    for sx in (-1, 1):
        for sz in (-1, 1):
            cyl(0.28 * k, 0.14 * k, at2(sx * 0.52 - (0.14 if sx > 0 else 0), 0.28, sz * 0.58), ROPE, segs=10, axis='across', yaw=yaw)
    if ore:
        rock_lump(0.58 * k, at2(0, 1.3, 0), ore_color, (0.9, 0.5, 1.35), yaw, seed=x)

def ground_poly(verts, faces, color):
    """Flat faces on the ground, drawn from ABOVE only: poly()'s back faces
    would be coplanar and fight the front ones for the depth test, the
    underside's dark light winning half the pixels."""
    me = bpy.data.meshes.new('ground')
    me.from_pydata([tuple(P(*v)) for v in verts], [], faces)
    me.update()
    for p in me.polygons:
        if p.normal.z < 0:
            p.flip()
    o = bpy.data.objects.new('ground', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

def tumbleweed(at, r):
    """A ball of dry scrub: two faceted shells of one size, one turned in the
    other, so their corners poke through each other's faces and it reads
    twiggy rather than solid. Plain icosahedra: one this small would come out
    of sphere() as a block."""
    for rr, color, sy, yaw in ((r, 0xb8a686, 1.0, 0.0), (r * 0.97, 0x8a6a46, 1.08, 0.63)):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=rr)
        o = bpy.context.active_object
        o.scale = (1.0, 1.0, sy)
        o.location = P(*at)
        o.rotation_euler = (0, 0, yaw)
        bpy.ops.object.shade_flat()
        paint(o, color)

def hawk_circle(c, y, R, period, k=1.0, tag='hawk'):
    """A hawk circling over the piece: a closed loop of `path_<tag>_<n>`
    empties `R` round (cx, cz) at height `y`, and the bird riding it
    (anim_path facing its way), wings spread and banked into the turn, 0.55
    u from tip to tip: twice a real hawk's span, the scale rule's most for a
    small living thing, flying low enough to read against the sky. `k` is the world's size in the builder's units (1 / the piece's
    grow). The bird is BUILT on the ground under the circle, its low wing
    tip on the floor: a traveller is drawn only on its path, so where it is
    built is just its pivot, and a bird built up in the air would stand in
    the piece's box, its sight points and the floating check as a part 5 u
    up that nothing holds."""
    cx, cz = c
    k *= 0.44                                            # the parts below are a 1.26 span's
    N = 24
    for n in range(N):                                   # angle up: +Z first, the centre on its right
        a = 2 * math.pi * n / N
        marker('path_%s_%d' % (tag, n), (cx + R * math.cos(a), y, cz + R * math.sin(a)))
    x0, y0, z0 = cx + R, 0.16 * k, cz
    bank = -0.38                                         # right wing (+Z) down, into the turn
    cb, sb = math.cos(bank), math.sin(bank)
    def b(size, dx, dy, dz, color):                      # a part of the bird, its frame tipped by the bank
        box([s * k for s in size], (x0 + dx * k, y0 + (dy * cb + dz * sb) * k, z0 + (-dy * sb + dz * cb) * k),
            color, pitch=bank)
    with animated('anim_path:c=%s:p=%.1f:f=1#%s' % (tag, period, tag), (x0, y0, z0)):
        b((0.34, 0.09, 0.11), 0, 0, 0, 'dark')                                   # the body
        b((0.09, 0.08, 0.09), 0.2, 0.03, 0, 'dark')                              # the head
        b((0.06, 0.04, 0.05), 0.26, 0.02, 0, 'yellow')                           # the bill
        b((0.14, 0.03, 0.16), -0.22, 0.0, 0, 'salmon')                           # the red tail, fanned
        for sd in (-1, 1):                                                       # the wings, a little raised
            b((0.2, 0.03, 0.42), 0.02, 0.03, sd * 0.26, 'dark')
            b((0.12, 0.03, 0.2), -0.02, 0.06, sd * 0.53, 'slate')               # the fingered tips

def sandstone_rock(at, k=1.0, yaw=0.0, color=0xc07a55):
    """A red-rock boulder bedded in the sand, a smaller one against it."""
    x, y, z = at
    rock_lump(0.72 * k, (x, y + 0.2 * k, z), color, (1.25, 0.62, 0.95), yaw, seed=x + z)
    rock_lump(0.42 * k, (x + 0.7 * k * math.cos(yaw + 0.9), y + 0.1 * k, z - 0.7 * k * math.sin(yaw + 0.9)), 0xd39a70,
              (1.1, 0.6, 1.0), yaw + 0.6, seed=x - z)

@piece(1.45)
def dry_creek():
    # Wash: the stretch of the dry wash nearest the road. The creek itself is
    # the track's land (tracks.js wash `land`: a plain wound across the map,
    # left unraised under the bridges); this piece's SET_GROUND holds the same
    # floor under it and a low cut bank either side. A pale gravel bed along X
    # between dark banks, stones on the bars, a saguaro and an ocotillo on
    # the bank. Tumbleweeds, each half a car high, blow down it: each rolls out of the
    # rock pile at the upwind end, bowls the length of the bed at a gust's
    # pace, bouncing and landing (a bob with a rest) and rolling as fast as it
    # goes, and vanishes into the pile at the far end; the hidden half of the
    # loop runs back under the ground (anim_path+spin+bob). A hawk circles
    # over the bed.
    L, W, BANK = 54.0, 3.0, 0.45
    zc = lambda x: 0.9 * math.sin(x / 6.5)                       # a wander inside the land's plain
    def wid(x):
        t = min(1.0, abs(x) / (L / 2))
        return W * max(0.0, 1 - t ** 3.0) ** 0.8
    N = 40
    def across(x):
        dz = 0.9 / 6.5 * math.cos(x / 6.5)
        nl = math.hypot(1.0, dz)
        return -dz / nl, 1.0 / nl
    def ribbon(half, y, color):
        verts, faces = [], []
        for i in range(N + 1):
            x = -L / 2 + L * i / N
            nx, nz = across(x)
            w = half(x)
            verts += [(x + nx * w, y, zc(x) + nz * w), (x - nx * w, y, zc(x) - nz * w)]
            if i:
                faces.append((2 * i - 2, 2 * i - 1, 2 * i + 1, 2 * i))
        ground_poly(verts, faces, color)
    ribbon(lambda x: wid(x) / 2 + BANK * wid(x) / W, 0.03, 'brown')    # the cut banks
    ribbon(lambda x: wid(x) / 2, 0.07, 'cream')                        # the gravel bed
    tones = ['grey', 'lavender', 'white', 'tan']
    for i in range(20):
        x = -L / 2 * 0.9 + L * 0.9 * (i + 0.5) / 20
        f = wid(x) / W
        nx, nz = across(x)
        off = (((i * 7) % 5) - 2) / 2.0 * max(wid(x), 0.6) * 0.42
        r = 0.32 + 0.3 * f + 0.1 * ((i * 3) % 3)
        box((r, 0.25 + 0.15 * f, r * 0.8), (x + nx * off, 0.12, zc(x) + nz * off), tones[i % 4], yaw=i * 0.7)
    END = L / 2 - 1.5
    for sx in (-1, 1):                                                 # the rock piles the weeds roll from and into
        x = sx * END
        sandstone_rock((x, 0, zc(x) - 0.2), 1.7, yaw=0.5 + sx)
        sandstone_rock((x + sx * 1.0, 0, zc(x) + 1.0), 1.3, yaw=1.6 - sx)
    group([o for o in bpy.context.scene.objects if o.type == 'MESH'], 'bed')   # one draw
    with plain_parts():                                                # in builder units: 1/1.45 of the world's
        saguaro((-6.0, 0, zc(-6.0) + 4.4), 2.5, arms=((0.4, 0.45, 0.3), (3.4, 0.58, 0.24)))
        ocotillo((-7.3, 0, zc(-7.3) + 3.6), 1.4, seed=3)
        brush((-5.0, 0, zc(-5.0) + 5.2), 0.7)
    sandstone_rock((-4.4, 0, zc(-4.4) + 3.2), 0.8, yaw=0.4)
    sandstone_rock((10.0, 0, zc(10.0) + 3.0), 0.7, yaw=1.2)
    # the tumbleweeds' loop: down the bed at its own height, then back under it
    R = 0.17
    xs = [-END + 2 * END * i / 12 for i in range(13)]
    for k, pt in enumerate([(x, R, zc(x)) for x in xs] + [(END, -1.9, zc(END)), (-END, -1.9, zc(-END))]):
        marker('path_weed_%d' % k, pt)
    for n in range(4):
        x = xs[1 + 3 * n]
        with animated('anim_path:c=weed:p=56:o=%.3f:f=1+spin:a=z:w=-11+bob:h=0.2:p=%.2f:r=0.35#%d'
                      % (n / 4, 0.7 + 0.06 * n, n), (x, R, zc(x))):
            tumbleweed((x, R, zc(x)), R)
    hawk_circle((2.0, 1.5), 3.6, 3.0, 15.0, k=1 / 1.45)

def cactus_limb(path, radii, ribs, side=(1.0, 0.0, 0.0), color='sage', pleat=0.78):
    """A ribbed cactus limb swept along glTF `path` (its radius at each point
    in `radii`): a star in section, `ribs` points, each face flat, so the
    pleats shade light and dark in turn as a saguaro's ribs do, closed over
    its tip in a low dome. `side` is the horizontal across the limb's own
    plane (an arm turns from out to up in it without twisting)."""
    import bmesh
    n = 2 * ribs
    u = Vector(side).normalized()
    pts = [Vector(p) for p in path]
    bm = bmesh.new()
    rings = []
    for i, (p, r) in enumerate(zip(pts, radii)):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        v = u.cross(t).normalized()
        rings.append([bm.verts.new(P(*(p + (u * math.cos(2 * math.pi * k / n) + v * math.sin(2 * math.pi * k / n))
                                       * (r if k % 2 == 0 else r * pleat))))
                      for k in range(n)])
    for a, b in zip(rings, rings[1:]):
        for k in range(n):
            bm.faces.new((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
    tip = bm.verts.new(P(*(pts[-1] + (pts[-1] - pts[-2]).normalized() * radii[-1] * 0.55)))
    for k in range(n):
        bm.faces.new((rings[-1][k], rings[-1][(k + 1) % n], tip))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('limb')
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new('limb', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

def saguaro(at, h, arms=((0.0, 0.45, 0.55),), yaw=0.0, ribs=(5, 4), bloom=False):
    """A saguaro `h` tall, the desert's own tall plant, in its dusty
    grey-green (the atlas's `sage`): a ribbed column swelling a little to
    its shoulder and rounded over its crown, each of its `arms` (turn about
    the trunk, height up it as a share of h, length up as a share of h)
    leaving the trunk level, turning up through a round elbow and rising
    beside it to its own rounded tip. `ribs` is the pleats of the trunk and
    of an arm (the scatter's take fewer); `bloom` crowns it with its cream
    flowers."""
    x, y, z = at
    r = 0.075 * h
    lean = ribs[0] < 5                                           # the scatter's: a ring fewer
    cactus_limb([(x, y - 0.1, z)] + ([] if lean else [(x, y + 0.5 * h, z)]) + [(x, y + 0.88 * h, z), (x, y + 0.97 * h, z)],
                [r * 0.95] + ([] if lean else [r]) + [r * 0.95, r * 0.62], ribs[0])
    ra = r * 0.72
    for a, at_h, up in arms:
        a += yaw
        c, sn = math.cos(a), math.sin(a)
        ey, re = y + h * at_h, ra * 1.5                          # the elbow's height, its bend's radius
        reach = r + ra * 1.9                                     # the arm's axis, out from the trunk's
        def out(d, dy):
            return (x + c * d, ey + dy, z - sn * d)
        top = re + h * up
        bend = (30, 60) if ribs[1] > 3 else ()                   # the elbow's facets
        arc = [out(reach - re * (1 - math.sin(math.radians(f))), re * (1 - math.cos(math.radians(f)))) for f in bend]
        cactus_limb([out(0.0, 0.0), out(reach - re, 0.0)] + arc + [out(reach, re), out(reach, top - ra), out(reach, top)],
                    [ra * 0.9, ra] + [ra * 1.04] * len(arc) + [ra, ra * 0.95, ra * 0.62], ribs[1], side=(sn, 0.0, c))
    if bloom:
        for k in range(3):
            a = yaw + 2.1 * k
            box((0.3 * r, 0.3 * r, 0.3 * r), (x + 0.42 * r * math.cos(a), y + h * 0.99 + 0.3 * r, z + 0.42 * r * math.sin(a)),
                'cream', yaw=a)

def ocotillo(at, h, n=5, seed=0):
    """An ocotillo `h` tall: a fountain of long spiny canes splaying from one
    root, each tipped with its red flower spike."""
    x, y, z = at
    for i in range(n):
        a = 2 * math.pi * (i + 0.37 * seed) / n
        lean = 0.22 + 0.12 * ((i * 5 + seed) % 3)
        L = h * (0.82 + 0.06 * ((i * 3 + seed) % 4))
        tip = (x + math.cos(a) * math.sin(lean) * L, y + math.cos(lean) * L, z - math.sin(a) * math.sin(lean) * L)
        rod((x, y, z), tip, 0.09, 'olive', r2=0.06, segs=3)
        top = (tip[0] + (tip[0] - x) * 0.1, tip[1] + 0.24, tip[2] + (tip[2] - z) * 0.1)
        rod(tip, top, 0.09, 'red', r2=0.04, segs=3)

def brush(at, k=1.0, yaw=0.0):
    """A clump of desert brush (creosote, bursage): two low faceted domes of
    dry olive, never a lawn's green."""
    x, y, z = at
    sphere(0.55 * k, (x, y + 0.12 * k, z), 'olive', scale=(1.0, 0.62, 0.9), yaw=yaw)
    sphere(0.4 * k, (x + 0.5 * k * math.cos(yaw), y + 0.08 * k, z + 0.32 * k), 'sage', scale=(1.0, 0.6, 1.0), yaw=yaw + 0.5)

def barrel_cactus(at, k=1.0):
    """A barrel cactus a knee high: a ribbed drum, its crown in flower."""
    x, y, z = at
    r = 0.24 * k
    cactus_limb([(x, y - 0.03, z), (x, y + 0.16 * k, z), (x, y + 0.32 * k, z), (x, y + 0.4 * k, z)],
                [r * 0.8, r, r * 0.92, r * 0.55], 6)
    for i in range(3):
        a = 2.1 * i + x
        box((0.1 * k, 0.07 * k, 0.1 * k), (x + 0.07 * k * math.cos(a), y + 0.46 * k, z + 0.07 * k * math.sin(a)),
            'yellow' if i else 'red', yaw=a)

def prickly_pear(at, k=1.0, yaw=0.0, pads=5):
    """A clump of prickly pear a car's bonnet high: flat oval pads growing
    one out of another, a red fruit on the rim of the top ones."""
    import bmesh
    x, y, z = at
    def pad(base, w, hh, a, lean, color):
        """One pad standing on glTF `base`, w wide and hh tall, its flat face
        turned to `a`, leaning back by `lean`; returns its top's middle."""
        fx, fz = math.cos(a), -math.sin(a)                       # the face's normal
        sx, sz = -fz, fx                                         # across the pad
        cl, sl = math.cos(lean), math.sin(lean)
        t = 0.09 * w
        rim = [(0.0, 0.0), (0.46, 0.2), (0.44, 0.74), (0.0, 1.0), (-0.44, 0.74), (-0.46, 0.2)]
        def pt(u, v, d):
            return P(base[0] + sx * u * w + fx * (d + sl * v * hh), base[1] + cl * v * hh, base[2] + sz * u * w + fz * (d + sl * v * hh))
        bm = bmesh.new()
        f = [bm.verts.new(pt(u, v, t)) for u, v in rim]
        b = [bm.verts.new(pt(u, v, -t)) for u, v in rim]
        bm.faces.new(f)
        bm.faces.new(b[::-1])
        for i in range(len(rim)):
            j = (i + 1) % len(rim)
            bm.faces.new((f[i], b[i], b[j], f[j]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new('pad')
        bm.to_mesh(me)
        bm.free()
        o = bpy.data.objects.new('pad', me)
        bpy.context.scene.collection.objects.link(o)
        paint(o, color)
        return (base[0] + fx * sl * hh * 0.9, base[1] + cl * hh * 0.9, base[2] + fz * sl * hh * 0.9)
    grown = []
    for i in range(pads):
        a = yaw + 1.9 * i + 0.4 * math.sin(3.1 * i)
        if i < 3:                                                 # the pads off the ground
            base = (x + 0.3 * k * math.cos(2.2 * i + yaw), y - 0.04 * k, z + 0.3 * k * math.sin(2.2 * i + yaw))
            w, hh = (0.5 - 0.05 * i) * k, (0.62 - 0.06 * i) * k
        else:                                                     # and the ones grown off them
            base = grown[i - 3]
            w, hh = 0.36 * k, 0.44 * k
        top = pad(base, w, hh, a, 0.18 + 0.1 * (i % 2), 'sage')
        grown.append(top)
        if i >= 2:
            box((0.09 * k, 0.12 * k, 0.09 * k), (top[0], top[1] + 0.06 * hh, top[2]), 'red', yaw=a)

# The canyon's scatter: one cactus each (theme.cc canyonTheme; a stamp sizes
# and turns it), the set pieces' own family, so a track's scattered cacti
# are its stands' cacti. Fewer ribs than a stand's: a stamp is drawn many
# times a frame.
@piece(1.0)
def cactus_saguaro():
    with plain_parts():
        saguaro((0, 0, 0), 3.4, arms=((0.3, 0.4, 0.4), (3.5, 0.52, 0.3)), ribs=(3, 2))
    join_still('cactus')

@piece(1.0)
def cactus_spear():
    with plain_parts():
        saguaro((0, 0, 0), 2.6, arms=((2.2, 0.5, 0.22),), ribs=(3, 2))
    join_still('cactus')

@piece(1.0)
def cactus_pear():
    with plain_parts():
        prickly_pear((0, 0, 0), 1.0, pads=4)
    join_still('cactus')

@piece(1.0)
def wash_bed():
    # Wash: one reach of the dry wash's gravel bed, the floor of the channel
    # its own SET_GROUND cuts between low banks (the plain it lies on). Placed
    # end to end, each reach overlapping the next, the bed winds across the
    # whole map and under the bridges where the road crosses it; the hero
    # (dry-creek) is the stretch by the north straight. 38 units along Z,
    # ragged, fading to stones at both ends where the next reach takes over;
    # ONE mesh (group), so a reach is one draw wherever it is seen.
    L, N = 38.0, 20
    def half(z):
        t = abs(z) / (L / 2)
        return (2.5 + 0.45 * math.sin(z * 0.7) + 0.3 * math.sin(z * 1.9 + 1.0)) * max(0.0, 1 - t ** 4) ** 0.5
    def ribbon(extra, y, color):
        verts, faces = [], []
        for i in range(N + 1):
            z = -L / 2 + L * i / N
            w = half(z) + extra * half(z) / 2.5
            verts += [(w, y, z), (-w, y, z)]
            if i:
                faces.append((2 * i - 2, 2 * i - 1, 2 * i + 1, 2 * i))
        ground_poly(verts, faces, color)
    ribbon(0.5, 0.03, 'brown')
    ribbon(0.0, 0.07, 'cream')
    tones = ['grey', 'lavender', 'white', 'tan']
    for i, (x, z, r) in enumerate(((0.8, -12.0, 0.5), (-1.2, -6.0, 0.4), (0.3, 1.0, 0.6),
                                   (1.4, 7.5, 0.35), (-0.6, 12.5, 0.5), (-1.9, -0.8, 0.3))):
        box((r, 0.2 + 0.2 * r, r * 0.8), (x, 0.1, z), tones[i % 4], yaw=i * 0.9)
    # The bed lies in its channel under the raised land, out of a racer's
    # sight but close by; what shows where the wash runs is what grows along
    # it, where the water is underground: on each bank a stand of saguaros
    # (the old one an old one's height, some fifteen metres), brush at a
    # foot, and red boulders on the bar. No tree: a desert wash reads as cactus and rock. The bed keeps
    # the shade it had under its stones (shade() runs the ramp to the
    # piece's new top, the saguaros). Where a reach runs under the road the
    # stands keep to the footprint every placement's road passes a kerb
    # clear of.
    bed = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    for o in bed:
        o['ramp'] = 0.84
    with plain_parts():
        saguaro((5.0, 0, 1.5), 4.6, arms=((0.3, 0.36, 0.42), (3.5, 0.48, 0.36), (1.9, 0.6, 0.26)), bloom=True)
        saguaro((5.9, 0, 0.5), 3.2, arms=((2.2, 0.45, 0.36),))
        brush((4.1, 0, 2.3), 1.2)
        saguaro((-4.0, 0, 3.5), 4.2, arms=((3.6, 0.4, 0.42), (0.4, 0.52, 0.32)))
        saguaro((-3.4, 0, 4.3), 2.9, arms=((5.0, 0.48, 0.34),))
        sandstone_rock((3.2, 0, 5.0), 1.4, yaw=0.7)
        sandstone_rock((-3.0, 0, 2.4), 1.2, yaw=2.1)
    group([o for o in bpy.context.scene.objects if o.type == 'MESH'], 'bed')

@piece(0.35)
def mine_portal():
    # Gulch: the mine, at the size of the thing (the builder works in units of
    # 1/0.35 of the world's): the adit's timbered portal a car high, standing
    # out of the face of a spur of the canyon's own banded rock (strata, as
    # the range's faces are; the piece's SET_GROUND ridge rising behind it,
    # -X, the track's own ridge beyond); a narrow-gauge line runs out of it
    # toward the road (+X) under the tipple (a bin on a trestle, its spout
    # over a cart) to a buffer stop. The ore line branches off it just
    # outside the adit (set-ore-line, on this piece's anchor at this piece's
    # grow), and its train goes home into the dark of the adit. The powder
    # shed stands upstream (-Z), its flag flapping; the yard in front is the
    # plain the SET_GROUND levels. From the tipple's bin a boarded gallery
    # climbs to the tramway's terminal (the stamp mill's piece builds both).
    g = 1 / GROW['mine-portal']
    spur = massif_height(((-11.5, 0.0, 13.5, 7.5, 9.0, 0.0, 0.45, 6.0), (-12.0, 11.0, 9.5, 6.5, 6.0, 0.3, 0.7, 0.0),
                          (-11.5, -11.5, 8.5, 6.0, 6.0, -0.2, 0.7, 0.0)), rough=1.2, seed=5.0, warp=1.5)
    def M(x, z):
        # the face cut back where the portal's timbers stand out of it
        return min(spur(x, z), 8.0 * (-5.6 - x)) if abs(z) < 1.9 else spur(x, z)
    canyon_rock(M, -22.0, 2.0, -21.0, 21.0, [(y0 * g, y1 * g, col, back * g if back > 0 else back)
                                              for y0, y1, col, back in CANYON_STRATA if y0 < 5.0],
                'rock', grid=0.7, tol=0.5, step=3.6, jitter=0.7, summits=False)
    with plain_parts():
        box((1.4, 3.0, 2.6), (-5.0, 1.5, 0), ROPE)                                   # the dark of the adit
        for z in (-1.45, 1.45):                                                      # its timbered sides and roof
            box((1.9, 3.3, 0.3), (-4.95, 1.65, z), TIMBER)
        box((2.0, 0.35, 3.3), (-4.95, 3.4, 0), TIMBER)
        for z in (-1.5, 1.5):
            box((0.5, 3.6, 0.5), (-4.1, 1.8, z), 0x9a7b55)
        box((0.6, 0.5, 4.2), (-4.1, 3.75, 0), 0x9a7b55)
        for z in (-2.4, 2.4):                                                        # lamps either side
            box((0.2, 2.4, 0.2), (-3.0, 1.2, z), 'slate')
            box((0.4, 0.4, 0.4), (-3.0, 2.5, z), 'yellow')
        for z in (-0.6, 0.6):                                                        # the line
            box((17.4, 0.2, 0.2), (4.4, 0.3, z), 'slate')
        for k in range(9):
            box((1.8, 0.2, 0.5), (-3.6 + k * 2.0, 0.1, 0), TIMBER)
        box((0.6, 0.9, 1.8), (13.3, 0.45, 0), TIMBER)                                # buffer stop
        box((0.3, 0.3, 2.2), (13.0, 0.75, 0), 'red')
        ore_cart((6.0, 0.3, 0), yaw=math.pi / 2, ore_color='yellow')                 # loading under the tipple
        # the tipple: a trestle over the line, the bin on its deck, a funnel under
        # the deck with its spout over the cart, a ladder up one leg
        for sx in (-1, 1):
            for sz in (-1, 1):
                box((0.4, 4.4, 0.4), (6.0 + sx * 1.6, 2.2, sz * 1.6), TIMBER)
            box((0.2, 0.2, 3.6), (6.0 + sx * 1.6, 2.6, 0), TIMBER, pitch=0.62)
        box((3.8, 0.3, 3.8), (6.0, 4.4, 0), TIMBER)
        box((3.2, 1.8, 3.2), (6.0, 5.45, 0), 0x9a7b55)
        box((3.5, 0.24, 3.5), (6.0, 6.45, 0), 'slate')
        box((1.5, 0.8, 1.5), (6.0, 3.85, 0), 0x9a7b55)
        box((0.7, 0.6, 0.7), (6.0, 3.15, 0), 0x9a7b55)
        for s in (-1, 1):
            box((0.2, 4.4, 0.2), (7.85, 2.2, -1.2 + s * 0.3), TIMBER)
        for i in range(6):
            box((0.2, 0.2, 0.6), (7.85, 0.5 + i * 0.7, -1.2), TIMBER)
        for k, (x, z) in enumerate(((8.6, 2.2), (9.4, 2.8), (8.9, 3.4))):            # gold ore spilled by the tipple
            rock_lump(0.34, (x, 0.14, z), 'yellow' if k % 2 == 0 else 0xa8623f, (1.1, 0.7, 1.0), 0.6 * k, seed=k)
    # the powder shed, set back from the line, crates of powder by the door
    hut(2.6, 2.0, 2.4, (1.4, 0, -6.8), TIMBER, 'slate')
    for k, (x, z, y) in enumerate(((3.4, -5.5, 0), (3.4, -6.5, 0), (3.4, -6.0, 0.8))):
        box((0.9, 0.8, 0.9), (x, y + 0.4, z), 0x9a7b55, yaw=0.1 * k)
    for k in range(4):
        box((0.16, 0.16, 0.6), (3.2 + k * 0.16, 1.7, -6.0), 'red')
    flagpole((-0.4, 0, -8.8), 3.4, 'red', w=1.0, fh=0.6, wave='anim_sway:a=z:d=24:p=2.0#1')
    group([o for o in bpy.context.scene.objects if o.type == 'MESH' and o.get('anim') is None and not o.get('group')], 'yard')

@piece(0.35)
@plain
def ore_line():
    # Gulch: the mine's narrow-gauge line, placed on the mine portal's own
    # anchor (this frame and grow are the portal's). It branches off the
    # portal's line just outside the adit, winds out of the yard along the
    # start straight and round the east bend, and ends in the loading shed
    # under the headframe's ore bin (placed to meet it). Its SET_GROUND is the
    # bed it lies in, one plain per chord of the route; the rails run on a
    # smooth curve through the chords' ends, the portal's gauge and sleepers,
    # and DRAPE: each run lies on the ground as it is drawn (toward the east
    # bend the land rises to the road's embankment, and rails built level
    # ran under it out of sight). A little train rides it (anim_path on a
    # draped chain, each wagon facing its way): a mine loco hauling three
    # carts of the shaft's gold ore out of the loading shed, the length of
    # the line at a mine train's walking pace against the racers down the
    # start straight, into the yard and the dark of the adit, home under
    # the ground. Cut in three runs (groups), so a cell draws only the runs
    # it sees.
    k = GROW['ore-line']
    pts = []
    for f in SET_GROUND['set-ore-line']:
        th = math.radians(f['yaw'])
        s, c = math.sin(th), math.cos(th)
        cx, cz = f['x'] * c + f['z'] * s, -f['x'] * s + f['z'] * c     # its offset is in its turned frame
        h = f['len'] / 2
        if not pts:
            pts.append(((cx - s * h) / k, (cz - c * h) / k))
        pts.append(((cx + s * h) / k, (cz + c * h) / k))
    # Catmull-Rom through them: out of the portal's line along +X, into the
    # collar along the last chord
    ext = ([(pts[1][0] - 2 * math.dist(pts[0], pts[1]), pts[1][1])] + pts
           + [(2 * pts[-1][0] - pts[-2][0], 2 * pts[-1][1] - pts[-2][1])])
    curve = [pts[0]]
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        n = max(1, math.ceil(math.dist(p1, p2) / 1.0))
        for j in range(1, n + 1):
            t = j / n
            curve.append(tuple(0.5 * (2 * p1[a] + (p2[a] - p0[a]) * t
                                      + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t * t
                                      + (3 * p1[a] - p0[a] - 3 * p2[a] + p3[a]) * t ** 3) for a in (0, 1)))
    acc = [0.0]
    for a, b in zip(curve, curve[1:]):
        acc.append(acc[-1] + math.dist(a, b))
    total = acc[-1]
    def on(s):
        """The point and the heading at `s` along the curve."""
        i = 0
        while i < len(curve) - 2 and acc[i + 1] < s:
            i += 1
        a, b = curve[i], curve[i + 1]
        d = max(1e-6, acc[i + 1] - acc[i])
        t = min(1.0, max(0.0, (s - acc[i]) / d))
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), ((b[0] - a[0]) / d, (b[1] - a[1]) / d)
    RAIL, TIE, Y = 12.0, 5.5, 0.3                                # a rail chord, the sleepers' spacing, rail height
    # Beside the low start straight the line crosses the flat on a low timber
    # trestle a few units past the kerb, up a ramp out of the yard and down
    # one into its cutting where the land rises toward the east bend, the
    # train riding along it at the racers' side (rails on the sand twelve
    # units out were a line a racer could not read).
    T0, T1, RISE, RAMP = 5.0 / k, 44.0 / k, 0.7 / k, 7.0 / k
    def ry(s):
        """The rails' height at `s` along the line."""
        t = min(1.0, max(0.0, (s - T0) / RAMP), max(0.0, (T1 - s) / RAMP))
        return Y + RISE * t * t * (3 - 2 * t)
    BENT = 2.6 / k
    nr = max(3, math.ceil(total / RAIL))
    ss = [total * i / nr for i in range(nr + 1)]
    for a0 in (T0, T1 - RAMP):                                   # the ramps in chords of a quarter
        for q in range(5):
            x = a0 + RAMP * q / 4
            if not any(abs(x - v) < RAMP / 8 for v in ss):
                ss.append(x)
    ss.sort()
    nr = len(ss) - 1
    for run in range(3):
        before = set(bpy.context.scene.objects)
        i0, i1 = nr * run // 3, nr * (run + 1) // 3
        for i in range(i0, i1):
            (pa, da), (pb, db) = on(ss[i]), on(ss[i + 1])
            ya, yb = ry(ss[i]), ry(ss[i + 1])
            for sd in (-1, 1):
                a = (pa[0] + da[1] * 0.6 * sd, ya, pa[1] - da[0] * 0.6 * sd)
                b = (pb[0] + db[1] * 0.6 * sd, yb, pb[1] - db[0] * 0.6 * sd)
                strut(a, b, 0.2, 'slate')
                if max(ya, yb) > Y + 0.3:                            # the trestle's stringers
                    strut((a[0], a[1] - 0.35, a[2]), (b[0], b[1] - 0.35, b[2]), 0.4, TIMBER)
        s = ss[i0] + TIE / 2
        while s < ss[i1]:
            p, d = on(s)
            box((1.8, 0.2, 0.5), (p[0], ry(s) - 0.2, p[1]), TIMBER, yaw=math.atan2(d[0], d[1]))
            s += TIE
        s = T0 + BENT / 2                                            # the trestle's bents
        while s < T1:
            if ss[i0] <= s < ss[i1] and ry(s) > Y + 0.5:
                (p, d), h = on(s), ry(s) - 0.55
                yaw = math.atan2(d[0], d[1])
                foot = [(p[0] + d[1] * 1.2 * sd, 0.0, p[1] - d[0] * 1.2 * sd) for sd in (-1, 1)]
                head = [(p[0] + d[1] * 0.9 * sd, h, p[1] - d[0] * 0.9 * sd) for sd in (-1, 1)]
                for f, t in zip(foot, head):
                    strut(f, t, 0.32, TIMBER)
                box((2.6, 0.3, 0.42), (p[0], h, p[1]), TIMBER, yaw=yaw)
                strut(foot[0], head[1], 0.16, TIMBER)
            s += BENT
        group([o for o in bpy.context.scene.objects if o not in before and o.type == 'MESH'], 'drape_line%d' % run)
    # the train's loop: up out of the ground inside the headframe's loading
    # shed, where no one sees it (the headframe stands 1.26 world on from the
    # line's end, the shed's middle 0.3 short of that end: headframe()), the
    # length of the line (over the trestle), in along the portal's line and
    # down into the ground behind the adit, then home under everything
    SHED = total - 0.3 / k
    loop = [(-8.0, -3.0, 0.0), (-5.2, Y, 0.0)]
    loop += [(p[0], ry(s), p[1]) for p, s in ((on(s)[0], s) for s in ss if s < SHED - 1.0)]
    (ex, ez), _ = on(SHED)
    loop += [(ex, Y, ez), (ex, -12.0, ez)]
    loop.reverse()
    for i, p in enumerate(loop):
        marker('path_drapeore_%d' % i, p)
    # a mine train's pace: about 2 world units a second round the whole loop
    span = sum(math.dist(a, b) for a, b in zip(loop, loop[1:] + loop[:1])) * k
    period = span / 2.0
    gap = 2.4 / (span / k)                                       # a wagon's length and its coupling, of the loop
    # its phase puts it on the start straight's trestle as a race's second
    # lap opens (the scene clock's, so the films' lap): a train a lap's
    # length behind it was only ever seen at the headframe
    PHASE = 0.27
    x0, z0 = pts[0]
    with animated('anim_path:c=drapeore:p=%.1f:o=%.4f:f=1#0' % (period, PHASE), (x0, Y, z0)):
        mine_loco((x0, Y, z0), yaw=math.pi / 2)
    for n in range(1, 4):
        with animated('anim_path:c=drapeore:p=%.1f:o=%.4f:f=1#%d' % (period, (PHASE - n * gap) % 1.0, n), (x0, Y, z0)):
            ore_cart((x0, Y, z0), yaw=math.pi / 2, ore_color='yellow')

# The lite tier's build of a canyon piece (the Android TV box draws
# set-<name>-lite.glb where one stands beside the model): the same builder
# with LITE on, where the helpers below leave out what a box's frame cannot
# show (trim, glazing bars, corner boards, hooves, guy ropes).
LITE = False

def lite_too(*names):
    for n in names:
        def build(fn=PIECES[n]):
            global LITE
            LITE = True
            try:
                fn()
            finally:
                LITE = False
        PIECES[n + '-lite'], GROW[n + '-lite'] = build, GROW[n]

def solid(verts, faces, color):
    """A closed faceted solid from glTF `verts` and `faces`, its normals
    turned outward: a gabled wall, a tub, a wedge of canvas."""
    import bmesh
    bm = bmesh.new()
    vs = [bm.verts.new(P(*v)) for v in verts]
    for f in faces:
        bm.faces.new([vs[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('solid')
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new('solid', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

def gabled(F, y0, w, d, h, rise, color):
    """Four walls and their two gables as ONE solid in the frame F: w across
    (X), d along the ridge (Z), h to the eaves, the gables `rise` over them.
    The roof lies on it: no wall stands through a roof."""
    sec = ((-w / 2, 0.0), (w / 2, 0.0), (w / 2, h), (0.0, h + rise), (-w / 2, h))
    verts = [F(x, y0 + y, -d / 2) for x, y in sec] + [F(x, y0 + y, d / 2) for x, y in sec]
    faces = [(0, 1, 2, 3, 4), (9, 8, 7, 6, 5)] + [(i, 5 + i, 5 + (i + 1) % 5, (i + 1) % 5) for i in range(5)]
    return solid(verts, faces, color)

def frame_house(at, yaw, w, d, h, rise, wall, roof, k=1.0, door=None, windows=(), sill=0x8a5f3e, trim=0xfde4c7,
                battens=0, pipe=None, over=None, corners=None):
    """A frame house at its own size beside a car, its ridge along its own Z
    (turned by `yaw`), `w` across and `d` along, `h` to the eaves and the
    gable `rise` over them: walls and gables one solid, a roof of two slabs
    lying on the gables with an overhang all round and a ridge board, a sill
    under the walls, corner boards, and what stands proud of the walls as a
    car's lamps do: a `door` (side, offset along the wall, width, height,
    colour) and `windows` (side, offset, height of its middle, width,
    height), each in a frame of `trim`, a window with a glazing bar. A side
    is '+x' or '-x' (an eave wall) or '+z' or '-z' (a gable). `battens`
    boards the +x wall with that many battens; `pipe` (x, z) stands a
    stovepipe through the roof. `k` sizes the dressing (1 for a house built
    in world units)."""
    F = local(at[0], at[2], yaw)
    y0 = at[1]
    gabled(F, y0, w, d, h, rise, wall)
    a = math.atan2(rise, w / 2)
    ov = 0.14 * k if over is None else over
    t = 0.07 * k
    sl = math.hypot(w / 2, rise) + ov
    for s in (-1, 1):
        cx = s * (sl / 2 * math.cos(a) + t / 2 * math.sin(a))    # its underside on the gables' slope
        cy = h + rise - sl / 2 * math.sin(a) + t / 2 * math.cos(a)
        box((sl, t, d + 2 * ov), F(cx, y0 + cy, 0), roof, yaw=yaw, roll=s * a)   # box()'s roll tips +X DOWN
    box((t * 1.8, t * 1.3, d + 2 * ov + 0.02 * k), F(0, y0 + h + rise + t * 0.9, 0), roof, yaw=yaw)
    def on(side, off, y, wd, ht, proud, color):
        e = proud * k
        if side in ('+x', '-x'):
            sx = 1 if side == '+x' else -1
            box((2 * e, ht, wd), F(sx * w / 2, y0 + y, off), color, yaw=yaw)
        else:
            sz = 1 if side == '+z' else -1
            box((wd, ht, 2 * e), F(off, y0 + y, sz * d / 2), color, yaw=yaw)
    with plain_parts():
        box((w + 0.08 * k, 0.1 * k, d + 0.08 * k), F(0, y0 + 0.05 * k, 0), sill, yaw=yaw)
        for sx in (-1, 1):                                       # the corner boards
            for sz in (-1, 1):
                if not LITE:
                    box((0.07 * k, h, 0.07 * k), F(sx * w / 2, y0 + h / 2, sz * d / 2), corners or sill, yaw=yaw)
        if door:
            side, off, wd, ht, col = door
            if not LITE:
                on(side, off, ht / 2 + 0.03 * k, wd + 0.12 * k, ht + 0.06 * k, 0.025, trim)
            on(side, off, ht / 2, wd, ht, 0.045, col)
        for side, off, y, wd, ht in windows:
            on(side, off, y, wd + 0.1 * k, ht + 0.1 * k, 0.025, trim)
            on(side, off, y, wd, ht, 0.04, 0x4f5260)
            if not LITE:
                on(side, off, y, 0.035 * k, ht, 0.055, trim)
        for i in range(0 if LITE else battens):
            z = -d / 2 + d * (i + 0.5) / battens
            box((0.04 * k, h - 0.12 * k, 0.045 * k), F(w / 2, y0 + h / 2 + 0.05 * k, z), sill, yaw=yaw)
    if pipe:
        px, pz = pipe
        py = h + rise * (1 - abs(px) / (w / 2)) - 0.05 * k
        top = h + rise + 0.32 * k
        cyl(0.055 * k, top - py, F(px, y0 + py, pz), 0x38383d, segs=6, stem=True)
        cyl(0.085 * k, 0.05 * k, F(px, y0 + top, pz), 0x38383d, segs=6)
    return F

def wall_tent(at, yaw, L=1.5, W=1.2, H=0.95, wall=0.38, canvas=0xfde4c7, shade=0xf2bf99, pipe=False):
    """A miner's wall tent at its own size, its door end on +X turned by
    `yaw`: low canvas walls under a pitched roof, all one solid; a fly sheet
    over the roof, proud of it at the eaves; the door open on the dark
    inside between two flaps tied back; the ridge pole standing out of both
    ends on its uprights, guy ropes from the eaves to the ground, and for a
    cook's tent a stovepipe through the roof."""
    F = local(at[0], at[2], yaw)
    y0 = at[1]
    sec = ((-W / 2, 0.0), (W / 2, 0.0), (W / 2, wall), (0.0, H), (-W / 2, wall))
    verts = [F(-L / 2, y0 + y, z) for z, y in sec] + [F(L / 2, y0 + y, z) for z, y in sec]
    solid(verts, [(0, 1, 2, 3, 4), (9, 8, 7, 6, 5)] + [(i, 5 + i, 5 + (i + 1) % 5, (i + 1) % 5) for i in range(5)], canvas)
    a = math.atan2(H - wall, W / 2)
    sl = math.hypot(W / 2, H - wall) + 0.1
    with plain_parts():
        for s in (-1, 1):                                        # the fly
            cz = s * (sl / 2 * math.cos(a))
            cy = H - sl / 2 * math.sin(a) + 0.035
            box((L + 0.14, 0.03, sl), F(0, y0 + cy, cz), shade, yaw=yaw, pitch=-s * a)
        box((0.03, H * 0.66, W * 0.34), F(L / 2, y0 + H * 0.33, 0), 0x5a4632, yaw=yaw)     # the dark inside
        for s in (-1, 1):                                        # the flaps, tied back
            poly([F(L / 2 + 0.03, y0 + H * 0.72, 0), F(L / 2 + 0.03, y0, s * W * 0.17), F(L / 2 + 0.05, y0, s * W * 0.36),
                  F(L / 2 + 0.05, y0 + H * 0.36, s * W * 0.3)], [(0, 1, 2, 3)], shade)
        box((L + 0.36, 0.045, 0.045), F(0, y0 + H + 0.02, 0), 0x8a5f3e, yaw=yaw)             # the ridge pole
        for sx in (-1, 1):
            box((0.045, H + 0.02, 0.045), F(sx * (L / 2 + 0.14), y0 + H / 2, 0), 0x8a5f3e, yaw=yaw)
        for sx in (() if LITE else (-0.34, 0.34)):               # the guys
            for s in (-1, 1):
                a0, b0 = F(sx * L, y0 + wall, s * W / 2), F(sx * L, y0, s * (W / 2 + 0.34))
                strut(a0, b0, 0.03, 0xb8a686)
    if pipe:
        cyl(0.05, 0.5, F(-L * 0.25, y0 + H * 0.78, W * 0.2), 0x38383d, segs=6, stem=True)

def crate(at, s=0.3, yaw=0.0, color=0x9a7b55):
    """A supply crate, its lid's battens a darker board."""
    x, y, z = at
    box((s, s, s), (x, y + s / 2, z), color, yaw=yaw)
    if not LITE:
        box((s * 1.04, s * 0.14, s * 0.22), (x, y + s * 0.96, z), 0x8a5f3e, yaw=yaw)

def keg(at, r=0.14, h=0.34, color=0x9a7b55):
    """A barrel standing, two iron hoops round it."""
    x, y, z = at
    cyl(r * 0.88, h, (x, y, z), color, segs=8)
    for f in (() if LITE else (0.22, 0.72)):
        cyl(r * 0.95, h * 0.1, (x, y + h * f, z), 0x4f5260, segs=8)

def rock_lump(r, at, color, scale=(1.0, 1.0, 1.0), yaw=0.0, seed=0.0):
    """One faceted lump of rock, its corners knocked in and out (`seed`, so
    no two alike): a boulder, a heap of ore. Its middle is at `at`."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=r)
    o = bpy.context.active_object
    for i, v in enumerate(o.data.vertices):
        v.co *= 1.0 + 0.16 * hash1(i, seed, 3.0)
    o.scale = (scale[0], scale[2], scale[1])
    o.location = P(*at)
    o.rotation_euler = (0, 0, yaw)
    bpy.ops.object.shade_flat()
    return paint(o, color)

def canyon_rock(M, x0, x1, z0, z1, bands, name, **kw):
    """strata_massif as ONE part `name` (`drape_...` to lie on the land): a
    ledge, a rim of slickrock, a spur's face, in the canyon's own strata."""
    before = set(bpy.context.scene.objects)
    strata_massif(M, x0, x1, z0, z1, bands, **kw)
    return group([o for o in bpy.context.scene.objects if o not in before and o.type == 'MESH'], name)

def equine(at, yaw, coat, L=0.62, ears=0.07, life=None, mane=0x5a4632, muzzle=0xf2bf99, legs=None, belly=None,
           tack=None, stripe=None, head=0.0, stance=0):
    """A horse or a burro at its own size beside a car (a horse some 0.6
    long, a burro less, its ears longer), facing +X turned by `yaw`,
    faceted as the canyon's rock is but a horse in outline: a barrel deep
    at the chest and round over the rump, slim legs with knee and hock
    over dark hooves (`legs` their stockings), a neck arching up out of the
    shoulder under its mane, a long head sloping to the muzzle, small
    pricked ears, a tail falling from the dock. `head` lowers the neck (1
    grazing), `stance` steps the legs. `belly` pales the underside,
    `stripe` draws a burro's dorsal stripe, `tack` (blanket, saddle)
    saddles it. The head and neck hinge for `life` (a calm dip and lift)."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    k = L / 0.62
    side = (s, 0.0, c)
    def p(dx, dy, dz=0.0):
        return (x + (dx * c + dz * s) * k, y + dy * k, z + (-dx * s + dz * c) * k)
    def r(*pairs):
        return [(a * k, b * k) for a, b in pairs]
    n = 4 if LITE else 6
    sock = legs or coat
    # the barrel, rump to chest
    loft([p(-0.29, 0.5), p(-0.2, 0.5), p(-0.02, 0.47), p(0.15, 0.475), p(0.25, 0.5)],
         r((0.07, 0.07), (0.115, 0.125), (0.105, 0.115), (0.11, 0.135), (0.07, 0.09)), coat, side, n)
    if belly and not LITE:
        loft([p(-0.14, 0.385), p(0.0, 0.37), p(0.14, 0.385)], r((0.06, 0.03), (0.085, 0.04), (0.06, 0.03)), belly, side, 4)
    if stripe and not LITE:
        box((0.44 * k, 0.02 * k, 0.035 * k), p(-0.04, 0.612), stripe, yaw=yaw)
    for i, (lx, lz) in enumerate(((0.19, -0.065), (0.19, 0.065), (-0.2, -0.07), (-0.2, 0.07))):
        d = (0.035, -0.02, -0.03, 0.03)[i] * stance                              # a step fore or aft
        if i < 2:                                                                # the forelegs: straight, a knee
            pts = [p(lx, 0.44, lz), p(lx + 0.01 + d * 0.4, 0.24, lz), p(lx + d, 0.07, lz)]
            rr = r((0.05, 0.055), (0.03, 0.032), (0.022, 0.024))
        else:                                                                    # the hind legs: stifle, hock, cannon
            pts = [p(lx, 0.46, lz), p(lx + 0.02, 0.33, lz), p(lx - 0.06 + d * 0.4, 0.23, lz), p(lx - 0.02 + d, 0.07, lz)]
            rr = r((0.065, 0.085), (0.045, 0.06), (0.03, 0.034), (0.022, 0.024))
        if LITE:
            pts, rr = [pts[0], pts[-2], pts[-1]], [rr[0], rr[-2], rr[-1]]
        loft(pts, rr, coat, side, 4, turn=math.pi / 4)
        hx = lx + d + (-0.02 if i >= 2 else 0.0)
        if sock != coat and not LITE:
            loft([p(hx - 0.005, 0.15, lz), p(hx, 0.06, lz)], r((0.027, 0.029), (0.024, 0.026)), sock, side, 4, turn=math.pi / 4)
        loft([p(hx, 0.07, lz), p(hx + 0.012, 0.0, lz)], r((0.028, 0.03), (0.036, 0.04)), sock if LITE else 0x38383d, side, 4,
             turn=math.pi / 4)
    # the tail, falling from the dock
    tail = [p(-0.29, 0.56), p(-0.36, 0.52), p(-0.385, 0.36), p(-0.37, 0.17)]
    loft(tail[1:] if LITE else tail, r((0.022, 0.024), (0.032, 0.036), (0.036, 0.04), (0.012, 0.014))[1 if LITE else 0:], mane, side,
         4, turn=math.pi / 4)
    if tack:
        blanket, saddle = tack
        with plain_parts():
            box((0.2 * k, 0.03 * k, 0.25 * k), p(-0.01, 0.6), blanket, yaw=yaw)
            box((0.15 * k, 0.05 * k, 0.19 * k), p(-0.01, 0.635), saddle, yaw=yaw)
            box((0.035 * k, 0.07 * k, 0.07 * k), p(0.06, 0.675), saddle, yaw=yaw)
    # the neck and head, turned down about the shoulder by `head`
    HX, HY = 0.2, 0.5
    dip = -1.25 * head
    cd, sd = math.cos(dip), math.sin(dip)
    def q(dx, dy, dz=0.0):
        ax, ay = dx - HX, dy - HY
        return p(HX + ax * cd - ay * sd, HY + ax * sd + ay * cd, dz)
    def neck_head():
        loft([q(0.16, 0.5), q(0.26, 0.6), q(0.33, 0.685), q(0.365, 0.73)],
             r((0.085, 0.12), (0.06, 0.085), (0.048, 0.062), (0.04, 0.045)), coat, side, n)
        loft([q(0.335, 0.745), q(0.425, 0.7), q(0.51, 0.63)],
             r((0.05, 0.055), (0.045, 0.05), (0.036, 0.038)), coat, side, n)                    # the long head
        loft([q(0.49, 0.648), q(0.57, 0.585)], r((0.036, 0.037), (0.032, 0.03)), muzzle, side, n)   # its muzzle
        if LITE:
            box((0.03 * k, 0.24 * k, 0.03 * k), q(0.24, 0.66), mane, yaw=yaw, roll=-0.75 - dip)
        else:
            loft([q(0.18, 0.62), q(0.25, 0.695), q(0.31, 0.76), q(0.345, 0.795)],
                 r((0.016, 0.02), (0.018, 0.03), (0.018, 0.03), (0.016, 0.02)), mane, side, 4, turn=math.pi / 4)   # the mane
        with plain_parts():
            if not LITE:
                box((0.03 * k, 0.03 * k, 0.105 * k), q(0.41, 0.725), 0x2a2735, yaw=yaw, roll=0.6 - dip)   # the eyes
                box((0.05 * k, 0.03 * k, 0.04 * k), q(0.385, 0.775), mane, yaw=yaw, roll=0.5 - dip)       # the forelock
            for ez in (-0.035, 0.035):
                box((0.028 * k, ears * k, 0.022 * k), q(0.335 - 0.2 * ears, 0.785 + ears * 0.45, ez), coat, yaw=yaw,
                    roll=0.35 - dip)
    if life:
        with animated(life, p(HX, HY), yaw):
            neck_head()
    else:
        neck_head()

def wagon(at, yaw, body=0x9a7b55, cover=None):
    """A buckboard (or, with a `cover`, a chuck wagon under its canvas), a
    racer and a half long, its tongue to +X turned by `yaw`."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def p(dx, dy, dz):
        return (x + dx * c + dz * s, y + dy, z - dx * s + dz * c)
    for lx, r in ((-0.42, 0.27), (0.42, 0.22)):
        for lz in (-0.33, 0.33):
            cyl(r, 0.06, p(lx, r, lz - 0.03), 0x5a4632, segs=10, axis='along', yaw=yaw)
    box((1.3, 0.12, 0.6), p(0, 0.42, 0), body, yaw=yaw)                          # the bed
    for lz in (-0.28, 0.28):
        box((1.3, 0.16, 0.05), p(0, 0.55, lz), body, yaw=yaw)
    box((0.12, 0.3, 0.6), p(0.5, 0.62, 0), body, yaw=yaw)                         # the seat's back
    box((0.9, 0.05, 0.05), p(1.0, 0.3, 0), 0x5a4632, yaw=yaw, roll=0.2)           # the tongue
    if cover:
        for i in range(4):
            box((0.06, 0.55, 0.66), p(-0.5 + i * 0.3, 0.86, 0), cover, yaw=yaw)
        box((0.96, 0.06, 0.66), p(-0.05, 1.12, 0), cover, yaw=yaw)

def false_front(z, w, d, h, body, front, kind='store', yaw=0.0):
    """A boomtown building at z on the street (its front at x 0 facing +X):
    `w` along the street, `d` deep, `h` to its eaves, a false front standing
    over the roof in `front`, a porch roof on posts over the boardwalk, a
    door and windows, its name on a board. `kind` dresses it: a `saloon`
    has batwing doors and its sign hanging from the porch, swinging."""
    box((d, h, w), (-d / 2, h / 2, z), body)
    box((d + 0.1, 0.1, w + 0.1), (-d / 2, h + 0.05, z), 0x8a5f3e)                  # the roof
    fh = h + 0.45
    box((0.12, fh, w), (0.0, fh / 2, z), front)                                    # the false front
    box((0.14, 0.12, w + 0.12), (0.0, fh + 0.06, z), 0x8a5f3e)                     # its cap
    box((0.1, 0.32, w * 0.7), (0.08, fh - 0.3, z), 0x4f5260)                       # the name board
    box((0.11, 0.12, w * 0.5), (0.1, fh - 0.3, z), 0xfde4c7)
    with plain_parts():
        box((0.7, 0.06, w), (0.4, h * 0.62, z), 0x8a5f3e)                          # the porch roof
        for sz in (-1, 1):
            box((0.07, h * 0.62, 0.07), (0.72, h * 0.31, z + sz * (w / 2 - 0.1)), 0x8a5f3e)
        box((0.06, h * 0.5, 0.34), (0.07, h * 0.25, z), 0x2a2735)                   # the door
        for sz in (-1, 1):
            box((0.06, 0.3, 0.3), (0.07, h * 0.42, z + sz * w * 0.3), 0x8ecae6)
        if kind == 'saloon':
            for sz in (-0.09, 0.09):
                box((0.05, 0.22, 0.16), (0.12, h * 0.25, z + sz), 0xfde4c7)       # the batwings
            box((0.05, 0.1, 0.05), (0.62, h * 0.62 - 0.08, z + w / 2 - 0.4), 0x2a2735)
            with animated('anim_sway:a=x:d=10:p=3.1#sign', (0.62, h * 0.62 - 0.12, z + w / 2 - 0.4)):
                box((0.05, 0.3, 0.5), (0.62, h * 0.62 - 0.32, z + w / 2 - 0.4), 0xc0392b)

def boardwalk(z0, z1):
    """The boardwalk along the fronts, flush with the ground (no step)."""
    with plain_parts():
        box((0.8, 0.06, z1 - z0), (0.4, 0.03, (z0 + z1) / 2), 0x9a7b55)

def water_tower_wild(x, z):
    """A railroad water tower on timber legs, its tank and spout."""
    with plain_parts():
        for sx in (-1, 1):
            for sz in (-1, 1):
                strut((x + sx * 0.6, 0, z + sz * 0.6), (x + sx * 0.45, 2.0, z + sz * 0.45), 0.12, 0x8a5f3e)
        box((1.1, 0.1, 1.1), (x, 2.02, z), 0x8a5f3e)
    cyl(0.62, 0.95, (x, 2.07, z), 0x9a7b55, segs=12)
    cyl(0.7, 0.4, (x, 3.02, z), 0x6e5b3a, r2=0.06, segs=12)
    box((0.08, 0.08, 0.5), (x + 0.35, 2.3, z + 0.5), 0x4f5260, pitch=-0.5)

@piece(1.0)
def boomtown_north():
    # Gulch: the gold camp's boomtown, its main street the north loop's top
    # (this side the street's north, +X the road, +Z the way the racers
    # run, west): the livery stable, its gable and big doors to the street,
    # a saddled bay tied at its rail by the trough; the general store, the
    # saloon with its sign swinging under the porch, the assay office, and
    # the water tower at the west end, each at its own size beside a car, on
    # one boardwalk flush with the ground, kegs and crates along it.
    frame_house((-1.5, 0, -9.0), math.pi / 2, 2.8, 2.7, 1.45, 0.8, 0x9a7b55, 0x6e5b3a,
                door=('+z', 0.0, 1.1, 1.1, 0x8a5f3e), windows=(('+x', 0.3, 0.85, 0.4, 0.4), ('-x', -0.3, 0.85, 0.4, 0.4)))
    with plain_parts():
        box((0.06, 1.1, 0.05), (-0.1, 0.55, -9.0), 0xb8a686)                      # the doors' meeting stile
        box((0.06, 0.4, 0.44), (-0.12, 1.75, -9.0), 0x8a5f3e)                     # the hayloft's door
        box((0.07, 0.07, 0.6), (0.0, 2.02, -9.0), 0x8a5f3e)                       # and its hoist beam
        box((0.06, 0.06, 1.6), (0.45, 0.4, -6.6), 0x8a5f3e)                       # the hitching rail
        for sz in (-0.75, 0.75):
            box((0.06, 0.4, 0.06), (0.45, 0.2, -6.6 + sz), 0x8a5f3e)
        box((0.3, 0.2, 0.8), (0.55, 0.1, -7.9), 0x8a5f3e)                         # the trough
        box((0.22, 0.03, 0.72), (0.55, 0.2, -7.9), 0x62d3c8)
        keg((0.25, 0.06, -4.7))
        keg((0.25, 0.06, 1.75))
        crate((0.3, 0.06, 2.2), 0.28, 0.2)
        crate((0.25, 0.06, 4.9), 0.3, -0.1)
    equine((0.2, 0, -6.6), math.pi / 2, 'brown', mane='dark', legs='dark', tack=(0xc0392b, 0x6e5b3a),
           life='anim_sway:a=z:d=20:p=6.3:r=0.7#h')
    false_front(-3.6, 2.6, 2.2, 1.5, 0xf2bf99, 0xfde4c7)                          # the general store
    false_front(0.0, 3.0, 2.6, 1.8, 0x9a7b55, 0xc0392b, kind='saloon')
    false_front(3.6, 2.2, 2.0, 1.4, 0x868ba1, 0x6794d9)                           # the assay office
    boardwalk(-5.0, 4.8)
    water_tower_wild(-1.4, 7.6)
    join_still('north')

@piece(1.0)
def boomtown_south():
    # ...and the street's south side (+X the road, +Z east, so its -Z end is
    # the west): the hotel, the barber's, the bank with a buckboard and its
    # horse standing at the boardwalk, and the chapel at the west end, its
    # steeple the street's vista as the racers run down it: a white
    # clapboard nave under a steep shingle roof, tall windows down its
    # sides, a square tower before its gable with the door in its foot, a
    # louvred belfry and a spire with its cross.
    false_front(5.6, 3.0, 2.6, 2.1, 0xfde4c7, 0x6794d9)                           # the hotel
    false_front(2.2, 2.0, 2.0, 1.4, 0xf2bf99, 0xcf534f)                           # the barber's
    false_front(-1.2, 2.6, 2.4, 1.6, 0x868ba1, 0xfde4c7)                          # the bank
    boardwalk(-2.6, 7.2)
    wagon((0.6, 0, -0.6), math.pi / 2)
    equine((0.6, 0, 0.75), math.pi / 2, 'brown', mane='dark', legs='dark',
           life='anim_sway:a=z:d=18:p=7.4:r=0.72#b')                             # a bay
    WHITE, SHINGLE = 0xfdf4de, 0x6e5b3a
    CZ = -6.6
    frame_house((-1.85, 0, CZ), math.pi / 2, 2.0, 2.6, 1.35, 1.0, WHITE, SHINGLE, sill=0x868ba1, corners=WHITE,
                windows=(('+x', -0.55, 0.8, 0.2, 0.62), ('+x', 0.45, 0.8, 0.2, 0.62),
                         ('-x', -0.55, 0.8, 0.2, 0.62), ('-x', 0.45, 0.8, 0.2, 0.62)))
    box((0.84, 2.55, 0.84), (-0.14, 1.275, CZ), WHITE)                            # the tower before the gable
    with plain_parts():
        box((0.94, 0.07, 0.94), (-0.14, 2.58, CZ), 0x868ba1)                      # its cornice
        box((0.92, 0.05, 0.92), (-0.14, 1.72, CZ), 0x868ba1)                      # the belfry's sill
        for a in range(4):                                                        # the belfry's louvres
            dx, dz = math.cos(a * math.pi / 2), math.sin(a * math.pi / 2)
            box((0.06 + 0.3 * abs(dz), 0.5, 0.06 + 0.3 * abs(dx)), (-0.14 + dx * 0.41, 2.12, CZ + dz * 0.41), 0x4f5260)
        box((0.06, 0.84, 0.48), (0.28, 0.44, CZ), 0x868ba1)                       # the door in its frame
        box((0.06, 0.74, 0.36), (0.3, 0.37, CZ), 0x6e5b3a)
        box((0.24, 0.06, 0.6), (0.4, 0.03, CZ), 0x868ba1)                         # its step
        box((0.05, 0.34, 0.05), (-0.14, 4.07, CZ), 0xfdf4de)                      # the cross
        box((0.05, 0.05, 0.2), (-0.14, 4.12, CZ), 0xfdf4de)
    cyl(0.62, 1.3, (-0.14, 2.61, CZ), SHINGLE, r2=0.03, segs=4, yaw=math.pi / 4)  # the spire
    join_still('south')

@piece(1.0)
def tailings_dump():
    # Gulch: the mine's tailings dump filling the inner loop: waste rock
    # tipped in two benches with a ragged lip (geometry: the loop's middle is
    # held under the deck cap, so no land can rise there), rubble fallen
    # round its foot, and up its face toward the road (-X) a timber incline
    # on its trestle to the winch frame at the top: a skip of waste rides up
    # it on the winch's cable and back down, its tub level on a wedge of a
    # frame, as an incline's cars are, at a mine cart's size.
    mound(2.0, 0.0, 0.0, 6.6, 6.6, 6.4, color='grey', rings=6, segs=18, sink=0.4, shape=0.55, jitter=0.35)
    mound(3.9, 0.6, 0.4, 3.6, 3.9, 3.8, color='grey', rings=5, segs=14, sink=0.2, shape=0.9, jitter=0.3)
    A, B = (-6.4, 0.25), (-1.0, 4.0)                                              # the incline's foot and head (x, y)
    slope = math.atan2(B[1] - A[1], B[0] - A[0])
    with plain_parts():
        for i in range(7):                                                         # rubble round its foot
            a = 2 * math.pi * (i + 0.4 * hash1(i, 7.0)) / 7
            q = 0.45 + 0.2 * (hash1(i, 3.0) + 1)
            rock_lump(q * 0.7, (6.9 * math.cos(a), q * 0.2, 6.7 * math.sin(a)), 'grey' if i % 2 else 0xa96545,
                      (1.3, 0.7, 1.0), a, seed=i)
        for i in range(6):                                                         # the incline's trestle
            t = i / 5
            x, y = A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t - 0.12
            for sz in (-0.3, 0.3):
                box((0.1, y + 0.3, 0.1), (x, (y + 0.3) / 2 - 0.15, sz), 0x8a5f3e)
            box((0.1, 0.1, 0.8), (x, y - 0.05, 0), 0x8a5f3e)
        for sz in (-0.22, 0.22):                                                   # its stringers, the rails on them
            beam((A[0], A[1] - 0.1, sz), (B[0], B[1] - 0.1, sz), 0.12, 0x8a5f3e)
            beam((A[0], A[1] - 0.01, sz), (B[0], B[1] - 0.01, sz), 0.05, 'slate')
        box((1.5, 0.1, 1.1), (B[0] + 0.55, B[1] - 0.08, 0.0), 0x8a5f3e)           # the head's deck
        for sx in (-0.1, 1.2):                                                     # on its own legs into the heap
            for sz in (-0.45, 0.45):
                box((0.1, 1.6, 0.1), (B[0] + sx, B[1] - 0.9, sz), 0x8a5f3e)
        for sz in (-0.42, 0.42):                                                   # the winch frame over it
            box((0.1, 1.1, 0.1), (B[0] + 0.9, B[1] + 0.5, sz), 0x8a5f3e)
            strut((B[0] + 0.3, B[1], sz), (B[0] + 0.9, B[1] + 0.9, sz), 0.07, 0x8a5f3e)
        box((0.1, 0.1, 0.96), (B[0] + 0.9, B[1] + 1.05, 0.0), 0x8a5f3e)
        cyl(0.2, 0.3, (B[0] + 0.9, B[1] + 0.75, -0.15), 0x4f5260, segs=8, axis='along')    # its drum
        strut((A[0] + 0.9, A[1] + 0.75, 0.0), (B[0] + 0.9, B[1] + 0.8, 0.0), 0.035, ROPE)  # the cable
    # the skip: up the incline and back (a two-point loop), never turning
    K = 0.36
    def on_incline(t):
        return A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1]) + 0.04
    sx, sy = on_incline(0.14)
    marker('path_skip_0', (sx, sy, 0.0))
    marker('path_skip_1', on_incline(0.84) + (0.0,))
    with animated('anim_path:c=skip:p=22:f=0#skip', (sx, sy, 0.0)):
        w = 1.9 * K                                                                # the wedge under the tub
        solid([(sx - w / 2, sy, -0.24), (sx + w / 2, sy + w * math.tan(slope), -0.24), (sx - w / 2, sy + w * math.tan(slope), -0.24),
               (sx - w / 2, sy, 0.24), (sx + w / 2, sy + w * math.tan(slope), 0.24), (sx - w / 2, sy + w * math.tan(slope), 0.24)],
              [(0, 1, 2), (5, 4, 3), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)], 0x8a5f3e)
        ore_cart((sx, sy + w * math.tan(slope) - 0.44 * K, 0.0), yaw=math.pi / 2, ore_color=0x868ba1, k=K)
    join_still('dump')

@piece(1.0)
def miners_camp():
    # Gulch: the miners' camp before the canyon (+X the road): three canvas
    # wall tents, low walls under pitched roofs and their flies, doors tied
    # open, guyed down, the cook's with its stovepipe; the chuck wagon under
    # its canvas, two burros standing by, the cook fire's ring of stones
    # under a kettle on its tripod with a thin wisp of smoke, the camp's
    # crates, kegs and tools, and a sluice box on its trestles, at their own
    # size beside a car.
    for k, (x, z, yaw) in enumerate(((-2.4, -2.8, 0.2), (-2.8, 0.3, -0.1), (-2.2, 3.2, 0.3))):
        wall_tent((x, 0, z), yaw, L=1.6, W=1.25, H=1.0, pipe=k == 0)
    wagon((-0.2, 0, -4.8), 0.3, cover=0xfdf4de)
    equine((0.1, 0, 2.2), 2.6, L=0.48, head=0.5, life='anim_sway:a=z:d=22:p=7.9:r=0.7#b1', **BURRO)
    equine((0.6, 0, 3.1), 1.9, L=0.46, stance=1, life='anim_sway:a=z:d=24:p=9.1:r=0.74#b2',
           **dict(BURRO, coat='brown', tack=(0xc0392b, 0x9a7b55)))
    FX, FZ = -0.6, -1.3
    with plain_parts():
        for i in range(7):                                                        # the fire ring
            a = 2 * math.pi * i / 7
            box((0.16, 0.1, 0.14), (FX + 0.3 * math.cos(a), 0.05, FZ + 0.3 * math.sin(a)), 0x868ba1, yaw=a)
        box((0.4, 0.06, 0.08), (FX, 0.07, FZ), 0x5a4632, yaw=0.5)
        box((0.4, 0.06, 0.08), (FX, 0.09, FZ), 0x5a4632, yaw=-0.6)
        for i in range(0 if LITE else 3):                                         # the tripod and its kettle
            a = 2 * math.pi * i / 3 + 0.4
            strut((FX + 0.42 * math.cos(a), 0.0, FZ + 0.42 * math.sin(a)), (FX, 0.8, FZ), 0.035, 0x38383d)
        if not LITE:
            box((0.03, 0.3, 0.03), (FX, 0.62, FZ), 0x38383d)
            cyl(0.11, 0.16, (FX, 0.3, FZ), 0x38383d, segs=8)
        crate((-1.3, 0, -0.9), 0.3, 0.3)
        crate((-1.35, 0.3, -0.92), 0.24, -0.2)
        crate((-1.0, 0, 1.6), 0.28, 0.1)
        keg((-1.0, 0, -0.5))
        keg((-0.9, 0, 4.2))
        if not LITE:
            strut((-1.12, 0.0, 1.95), (-1.02, 0.62, 1.72), 0.03, 0x8a5f3e)       # a shovel and a pick against a crate
            box((0.12, 0.16, 0.03), (-1.13, 0.06, 1.97), 0x868ba1)
            strut((-0.78, 0.0, 1.9), (-0.9, 0.6, 1.66), 0.03, 0x8a5f3e)
            box((0.34, 0.04, 0.04), (-0.9, 0.6, 1.66), 0x868ba1, yaw=0.5)
    marker('anim_smoke:s=0.6', (FX, 0.5, FZ))
    with plain_parts():                                                            # the sluice box
        for z in (5.0, 6.4, 7.8):
            for sx in (-0.16, 0.16):
                box((0.06, 0.7 - (z - 5.0) * 0.1, 0.06), (-1.6 + sx, (0.7 - (z - 5.0) * 0.1) / 2, z), 0x8a5f3e)
        box((0.34, 0.06, 3.4), (-1.6, 0.6, 6.4), 0x9a7b55, pitch=0.1)
        for sx in (-1, 1):
            box((0.04, 0.14, 3.4), (-1.6 + sx * 0.17, 0.66, 6.4), 0x9a7b55, pitch=0.1)
    join_still('camp')

def mine_loco(at, yaw=0.0):
    """A little battery loco for the mine line, along its local Z (its front
    +Z): a low green body on four wheels, a cab at the back with a roof on
    posts, a lamp on the nose."""
    x, y, z = at
    c, sn = math.cos(yaw), math.sin(yaw)
    def at2(dx, dy, dz):
        return (x + dx * c + dz * sn, y + dy, z - dx * sn + dz * c)
    box((1.2, 0.7, 2.0), at2(0, 0.75, 0.1), 0x3fa14e, yaw=yaw)
    box((1.3, 0.12, 2.2), at2(0, 0.42, 0.1), 'slate', yaw=yaw)
    for sx in (-1, 1):
        box((0.12, 0.9, 0.12), at2(sx * 0.5, 1.55, -0.75), 'slate', yaw=yaw)
    box((1.3, 0.14, 1.0), at2(0, 2.05, -0.6), 'red', yaw=yaw)
    box((0.4, 0.3, 0.2), at2(0, 1.0, 1.15), 'yellow', yaw=yaw)
    for sx in (-1, 1):
        for sz in (-1, 1):
            cyl(0.26, 0.16, at2(sx * 0.6 - (0.16 if sx > 0 else 0), 0.3, 0.1 + sz * 0.6), ROPE, segs=8, axis='across', yaw=yaw)

# ---- GULCH: the stamp mill and its ore tramway ----------------------------------------
# Across the start straight from the adit, the mine's stamp mill cascades down
# its spoil bank toward the road, the way a mill is built down a hillside: the
# ore bin under the tramway's terminal at the top, the battery house with its
# five stamps lifting and dropping in turn open to the road below it, the
# tables' house at the foot, each a lean-to roof of tin stepping down from the
# one above, the boiler house and its iron stack beside them. The bank is the
# mill's own waste rock, geometry falling to the yard round it. Buckets ride
# the tramway's two ropes from the terminal over the start straight to the
# tower beside the adit and back, the ropes sagging between, a bucket's foot
# never under OVER_GAP (3 u) plus a margin over the deck where it crosses it.
# Authored in metres, grown REAL; +X to the road and on over it. Square-edged
# (plain_parts): at a metre a post, the chamfer cannot be seen.

IRON, RUST, TIN = 0x38383d, 0xb06041, 'grey'

def stamp_battery(x, y, z0, n=5, pitch=2.2):
    """A battery of stamps across Z at x: the frame, the cam shaft over it and
    `n` stems with their shoes, each lifting and dropping a little in turn."""
    half = (n - 1) * pitch / 2
    for s in (-1, 1):
        box((0.6, 6.4, 0.6), (x - 0.6, y + 3.2, z0 + s * (half + 1.2)), TIMBER)
        box((0.6, 6.4, 0.6), (x + 0.9, y + 3.2, z0 + s * (half + 1.2)), TIMBER)
    box((2.2, 0.6, 2 * half + 3.2), (x + 0.15, y + 6.2, z0), TIMBER)                 # the cap sill
    box((2.2, 0.5, 2 * half + 3.2), (x + 0.15, y + 0.25, z0), 'grey')                # the mortar
    cyl(0.45, 2 * half + 3.4, (x + 0.15, y + 6.9, z0 - half - 1.7), IRON, segs=8, axis='along')  # cam shaft
    for k in range(n):
        z = z0 - half + k * pitch
        with animated('anim_bob:h=1.2:p=1.4:b=1:o=%.2f#stamp%d' % (k / n, k), (x + 0.15, y + 0.5, z)):
            box((0.7, 5.0, 0.7), (x + 0.15, y + 3.4, z), 'cream')                    # stem
            box((1.3, 1.2, 1.3), (x + 0.15, y + 1.1, z), IRON)                       # shoe
            box((1.0, 0.6, 1.0), (x + 0.15, y + 5.3, z), 'red')                      # tappet

BOARD = 0x9a7b55   # weathered board walls, lighter than the timbers that frame them

def lean_to(x0, x1, w, y, hb, hf, open_front=False, windows=0, roof=TIN):
    """A mill house from x0 (its back, uphill) to x1 (its front, toward the
    road), w across Z, standing at y: board walls hf tall at the front and
    hb at the back and the gables between them ONE solid, a tin roof lying
    on it with an eave all round, a fascia under its front edge, timber
    posts at its corners. `open_front` stops the walls short and carries the
    roof on over the open bay on posts and a beam. Returns the roof's height
    at its front edge."""
    d = x1 - x0
    back = x0 + (d * 0.45 if open_front else d)       # an open front: the walls stop short
    hm = hb + (hf - hb) * (back - x0) / d             # the walls' height where they stop
    sec = ((x0, 0.0), (back, 0.0), (back, hm), (x0, hb))
    verts = [(x, y + h, -w / 2) for x, h in sec] + [(x, y + h, w / 2) for x, h in sec]
    solid(verts, [(0, 1, 2, 3), (7, 6, 5, 4)] + [(i, 4 + i, 4 + (i + 1) % 4, (i + 1) % 4) for i in range(4)], BOARD)
    a = math.atan2(hb - hf, d)
    ov, t = 0.9, 0.4
    run = math.hypot(d, hb - hf) + 2 * ov
    box((run, t, w + 2 * ov), ((x0 + x1) / 2 + math.sin(a) * t / 2, y + (hb + hf) / 2 + math.cos(a) * t / 2, 0.0), roof, roll=a)
    box((0.3, 0.7, w + 2 * ov), (x1 + ov * math.cos(a), y + hf - ov * math.sin(a) - 0.2, 0.0), TIMBER)   # the fascia
    for sz in (-1, 1):
        for x, h in (() if LITE else ((x0, hb), (back, hm))):                     # the corner posts
            box((0.5, h, 0.5), (x, y + h / 2, sz * w / 2), TIMBER)
        if open_front:
            box((0.6, hf, 0.6), (x1 - 0.3, y + hf / 2, sz * (w / 2 - 0.3)), TIMBER)
    if open_front:
        box((0.6, 0.6, w), (x1 - 0.3, y + hf - 0.3, 0.0), TIMBER)
    for k in range(windows):
        window(local(0.0, 0.0, 0.0), 0.0, x1, y + hf * 0.55, -w / 2 + w * (k + 0.5) / windows, w=1.4, h=1.6)
    return y + hf

def ore_bucket(at):
    x, y, z = at
    box((0.35, 2.2, 0.35), (x, y - 1.1, z), IRON)                                    # hanger
    box((2.4, 1.8, 2.0), (x, y - 3.1, z), RUST)
    box((1.6, 0.5, 1.3), (x, y - 2.0, z), 0xffc044)                                  # ore heaped in it

# Where the mine portal's tipple stands in the stamp mill's frame, metres (the
# portal's piece is placed MILL_PORTAL world units on down the track and as
# far over the road as the tramway's tower: tracks.js gulch `set`), and the
# top of its bin: the gallery to the tramway starts there.
MILL_PORTAL = 5.8
MILL_TIPPLE = ((27.0 - 6.0 * 0.35) / REAL, 6.6 * 0.35 / REAL, -MILL_PORTAL / REAL)

@piece(REAL)
@plain
def stamp_mill():
    ROPE_Y, SAG, GAP = 24.0, 4.0, 3.0              # the ropes at their towers, their sag, each one's offset across
    T0 = -11.0                                     # the terminal's bull wheel, along +X
    OUT = 27.0 / REAL                              # the tower beside the adit
    # the bank: a heap of the mill's pale tailings, level where its houses stand,
    # rough slopes between, falling away behind and to the yard either side
    # and spilling a fan of tailings toward the road
    xs = (-40.0, -30.0, -25.0, -9.0, -6.5, 2.0, 4.0, 11.5, 16.5)
    ys = (-1.2, 6.5, 10.5, 10.5, 6.0, 6.0, 2.4, 2.4, -1.2)
    zs = (-27.0, -19.0, -12.0, 0.0, 12.0, 19.0, 27.0)
    n = len(xs)
    def bank(i, j):
        f = max(0.0, min(1.0, (27.0 - abs(zs[j])) / 12.0))
        f = f * f * (3 - 2 * f)
        pad = 0 < i < n - 1 and (ys[i] == ys[i - 1] or ys[i] == ys[i + 1]) and f == 1.0
        rough = 0.0 if pad or i in (0, n - 1) or j in (0, len(zs) - 1) else 1.0
        return (xs[i] + rough * 0.9 * math.sin(3.1 * j + 1.7 * i),
                ys[i] * f - 1.2 * (1 - f) + rough * 0.7 * math.sin(2.3 * j - 1.1 * i + 0.4), zs[j])
    verts = [bank(i, j) for j in range(len(zs)) for i in range(n)]
    ground_poly(verts, [(j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i)
                        for j in range(len(zs) - 1) for i in range(n - 1)], 'tan')
    # the ore bin at the top, the tramway's terminal standing over its front
    # under a roof of its own: the buckets come in under it and tip
    top = lean_to(-24.0, -10.0, 13.0, 10.5, 10.0, 7.0, roof=RUST)
    for sz in (-1, 1):
        for lx in (-14.0, -8.0):
            box((0.7, ROPE_Y + 4.2 - top, 0.7), (lx, (ROPE_Y + 4.2 + top) / 2, sz * 4.6), TIMBER)
        strut((-14.0, top + 1.0, sz * 4.6), (-8.0, ROPE_Y - 2.0, sz * 4.6), 0.45, TIMBER)
    box((7.4, 0.5, 10.4), (-11.0, ROPE_Y - 4.6, 0.0), TIMBER)                         # the tipping floor
    frame_house((-11.0, ROPE_Y + 3.6, 0.0), math.pi / 2, 10.4, 7.4, 0.8, 2.4, BOARD, RUST, k=4.0)
    cyl(GAP + 0.3, 0.5, (T0, ROPE_Y - 0.25, 0.0), IRON, segs=14)                      # the bull wheel
    # the battery house, open to the road, the battery under its roof's front
    lean_to(-6.5, 3.0, 16.0, 6.0, 11.0, 7.4, open_front=True)
    stamp_battery(1.0, 6.0, 0.0)
    box((7.0, 0.5, 0.9), (-7.0, 13.2, -5.5), TIMBER, roll=0.45)                       # the ore chute down from the bin
    # the boiler house beside it, its stack the mill's tallest thing
    frame_house((-3.0, 6.0, 11.0), 0.0, 6.0, 5.0, 5.0, 2.6, BOARD, RUST, k=4.0, door=('+x', 0.0, 1.6, 3.2, TIMBER),
                windows=(('+z', 0.0, 3.0, 1.4, 1.6),))
    cyl(0.8, 19.0, (-4.6, 6.0, 12.4), IRON, segs=8, stem=True)
    cyl(1.15, 0.7, (-4.6, 25.0, 12.4), IRON, segs=8)
    marker('anim_smoke', (-4.6, 26.2, 12.4))
    # the tables' house at the foot, its windows to the road
    lean_to(4.0, 11.0, 14.0, 2.4, 7.0, 4.6, windows=3, roof=RUST)
    # the terminal beside the adit: a tower of two splayed legs each side,
    # braced, the ore house on its head under its own roof, where the
    # buckets are filled; the mine's ore comes up to it from the tipple's bin
    # in a boarded gallery on trestle legs
    for s in (-1, 1):
        for lx in (-3.0, 3.0):
            strut((OUT + lx, -2.0, s * 4.8), (OUT + lx * 0.4, ROPE_Y - 4.6, s * (GAP + 1.0)), 0.9, TIMBER)
        strut((OUT - 2.6, 7.0, s * 4.4), (OUT + 2.6, 7.0, s * 4.4), 0.55, TIMBER)
        strut((OUT - 2.6, 7.0, s * 4.4), (OUT + 1.6, 15.0, s * 4.1), 0.45, TIMBER)
    box((8.6, 0.6, 2 * GAP + 4.0), (OUT + 1.5, ROPE_Y - 4.4, 0.0), TIMBER)            # its floor
    box((3.0, 6.4, 2 * GAP + 3.2), (OUT + 3.9, ROPE_Y - 0.9, 0.0), BOARD)             # the ore house behind the sheaves
    frame_house((OUT + 1.5, ROPE_Y + 2.3, 0.0), math.pi / 2, 2 * GAP + 4.4, 8.8, 0.7, 2.2, BOARD, RUST, k=4.0)
    for s in (-1, 1):
        box((0.5, 6.8, 0.5), (OUT - 2.4, ROPE_Y - 0.9, s * (GAP + 1.6)), TIMBER)
        cyl(1.2, 0.5, (OUT - 0.6, ROPE_Y + 0.1, s * GAP - 0.25), IRON, segs=10, axis='along')
    TX, TY, TZ = MILL_TIPPLE
    ga, gb = (TX, TY + 1.0, TZ), (OUT + 3.9, ROPE_Y - 2.6, -GAP - 1.4)
    beam(ga, gb, 2.0, BOARD)                                                          # the gallery
    beam((ga[0], ga[1] + 1.15, ga[2]), (gb[0], gb[1] + 1.15, gb[2]), 2.5, RUST, d=0.3)
    for f in (0.36, 0.7):                                                              # its trestle legs
        mx, my, mz = (ga[i] + (gb[i] - ga[i]) * f for i in range(3))
        for s in (-1, 1):
            strut((mx + s * 2.2, -1.0, mz + s * 0.8), (mx + s * 0.6, my - 0.8, mz + s * 0.2), 0.55, TIMBER)
    # the two ropes sagging over the road, fat enough to read in a split cell
    ropes = [sag((T0, ROPE_Y, s * GAP), (OUT - 0.6, ROPE_Y, s * GAP), SAG, n=7) for s in (-1, 1)]
    for pts in ropes:
        for a, b in zip(pts, pts[1:]):
            strut(a, b, 0.6, 'dark')
    join_still('mill')
    # the buckets: out on one rope, round the tower's sheave, home on the
    # other, round the bull wheel
    loop = ropes[0] + [(OUT + 0.6, ROPE_Y, 0.0)] + ropes[1][::-1] + [(T0 - GAP, ROPE_Y, 0.0)]
    for i, p in enumerate(loop):
        marker('path_tram_%d' % i, p)
    span = sum(math.dist(a, b) for a, b in zip(loop, loop[1:] + loop[:1])) * REAL
    N = 8
    for k in range(N):
        with animated('anim_path:c=tram:p=%.1f:o=%.4f:f=1#%d' % (span / 1.2, k / N, k), loop[0]):
            ore_bucket(loop[0])

def telegraph_pole(at, H, yaw=0.0, corner=False):
    """A telegraph pole `H` tall, its crossarm across the line (the line runs
    along the pole's Z turned by `yaw`), two insulators' worth of arm; a
    `corner` pole carries a second arm square to the first, where the line
    turns."""
    x, y, z = at
    cyl(0.06, H, (x, y, z), TIMBER, r2=0.05, segs=6, smooth=False)
    box((0.86, 0.1, 0.1), (x, y + H - 0.2, z), TIMBER, yaw=yaw)
    if corner:
        box((0.1, 0.1, 0.86), (x, y + H - 0.34, z), TIMBER, yaw=yaw)

def telegraph_span(a, b, ya, yb, yaw_a=0.0, yaw_b=0.0, arm=(-0.32, 0.0, 0.32)):
    """Three wires from the pole at glTF (x, z) `a`, its arm at height ya, to
    the one at `b`, sagging a little."""
    L = math.dist(a, b)
    for k in arm:
        p = (a[0] + k * math.cos(yaw_a), ya, a[1] - k * math.sin(yaw_a))
        q = (b[0] + k * math.cos(yaw_b), yb, b[1] - k * math.sin(yaw_b))
        tube(sag(p, q, 0.012 * L, n=3), 0.025, ROPE, res=1, bevel_res=0, wire=True)

# Sidewinder's telegraph line: its corner pole in its own piece's frame (the
# far verge from the filling station, whose piece carries the span over the
# road: STATION_WIRE is the same pole there), and the two tall poles' height.
TEL_CORNER, TEL_TALL = (0.0, -18.1), 4.3

@piece(1.0)
def telegraph_line():
    # Sidewinder: the oil field's telegraph line. It comes in across the
    # open desert from the east, square to the long straight, a pole every
    # sixteen units at a real pole's height (two car lengths) out to where
    # the dust takes it, to its corner pole on the straight's right verge by
    # the filling station; from there two tall poles carry it over the road
    # (the station's own piece has the near one, the span and the drop to
    # its shop). It never comes near the mountain: a line over the tunnel
    # read as wires through the rock. The run DRAPES, each pole on the land
    # as drawn, so it stands on whatever rise the desert has out there. A
    # highway sign faces the oncoming traffic by the straight. In runs of
    # four spans, a draw each, so a cell draws only the runs it sees.
    H = 1.9
    zc = TEL_CORNER[1]
    xs = [0.0] + [-14.0 - 16.0 * i for i in range(12)]           # the corner pole, then out across the desert
    hs = [TEL_TALL, 2.9] + [H] * (len(xs) - 2)
    for r0 in range(0, len(xs), 4):
        before = set(bpy.context.scene.objects)
        for i in range(r0, min(r0 + 4, len(xs))):
            telegraph_pole((xs[i], 0, zc), hs[i], yaw=math.pi / 2, corner=i == 0)
            if i + 1 < len(xs):
                telegraph_span((xs[i], zc), (xs[i + 1], zc), hs[i] - 0.05, hs[i + 1] - 0.05, yaw_a=math.pi / 2, yaw_b=math.pi / 2)
        if r0 == 0:                                              # the corner pole's stay, along the straight
            box((0.04, 0.04, math.hypot(TEL_TALL - 0.5, 1.6)), (0, (TEL_TALL - 0.4) / 2, zc + 0.8), ROPE,
                pitch=-math.atan2(TEL_TALL - 0.5, 1.6))
            box((0.18, 0.12, 0.18), (0, 0.06, zc + 1.65), TIMBER)
        group([o for o in bpy.context.scene.objects if o not in before and o.type == 'MESH'], 'drape_run%d' % r0)
    with plain_parts():
        box((0.1, 0.9, 0.1), (-0.8, 0.45, zc + 22.0), 'slate')                   # the highway sign
        box((0.06, 0.4, 0.6), (-0.8, 1.05, zc + 22.0), 0xd9b054)
        box((0.07, 0.08, 0.42), (-0.77, 1.05, zc + 22.0), ROPE)
    group([o for o in bpy.context.scene.objects if o.type == 'MESH' and not o.get('group')], 'drape_sign')

@piece(0.55)
@plain
def dead_cottonwood():
    # Wash's support: a lone dead cottonwood a big one's height on the bank
    # (some 23 m), a vulture perched on its top looking out at the road, a
    # fallen limb, red rocks and a tumbleweed at its foot (the builder's
    # units are 1/0.55 of the world's; the vulture and the weed keep their
    # own size).
    dead_tree((0, 0, 0), h=9.5, color=0x8a6a46)
    o = cyl(0.2, 3.6, (1.2, 0.2, 1.0), 0x8a6a46, r2=0.1, segs=5, axis='along', smooth=False)
    o.rotation_euler.z = 0.6
    vy, k = 9.5, 0.47 / GROW['dead-cottonwood']                                 # the vulture, turning
    def v(size, d, color, pitch=0.0):                                            # on its perch to watch
        box([s * k for s in size], (d[0] * k, vy + d[1] * k, d[2] * k), color, pitch=pitch)   # the cars go by
    with animated('anim_watch:r=24:d=75#v', (0, vy, 0)):
        v((0.7, 0.6, 0.55), (0, 0.42, 0), 'dark')
        for sd in (-1, 1):
            v((0.8, 0.5, 0.12), (-0.08, 0.48, sd * 0.33), 'slate')
        v((0.5, 0.12, 0.4), (-0.5, 0.25, 0), 'dark')
        v((0.36, 0.16, 0.46), (0.22, 0.74, 0), 'white')
        v((0.16, 0.26, 0.16), (0.3, 0.92, 0), 'salmon')
        v((0.32, 0.24, 0.26), (0.4, 1.1, 0), 'red')
        v((0.2, 0.1, 0.12), (0.62, 1.06, 0), 'cream')
        for sd in (-1, 1):
            v((0.12, 0.12, 0.08), (0.48, 1.16, sd * 0.13), 'dark')
    sandstone_rock((-2.6, 0, -1.6), 1.1, yaw=1.2)
    sandstone_rock((2.8, 0, -2.6), 0.8, yaw=0.2)
    tumbleweed((-1.8, 0.43, 2.2), 0.43)
    join_still('tree')

def windpump_body(x0, z0, k, tag='', yaw=0.0):
    """An old farm windpump at (x0, z0), `k` the size of the 7 unit one: a
    wooden tower braced corner to corner, the wheel of narrow wooden blades
    up top facing +X turned by `yaw` (into the wind) with its tail vane
    behind, the pump rod down the middle to the pump head, its spout over a
    plank trough at the foot. The wheel turns (anim_spin)."""
    before = set(bpy.context.scene.objects)
    c, s = math.cos(yaw), math.sin(yaw)
    H = 7.0 * k
    WOOD, BLADE = 0x8a6a46, 'tan'
    def leg(sx, sz, y):                                                          # a leg's corner at height y
        w = (0.8 - y / k * 0.07) * k
        return (x0 + sx * w, y, z0 + sz * w)
    for sx in (-1, 1):
        for sz in (-1, 1):
            strut(leg(sx, sz, 0.0), leg(sx, sz, H), 0.2 * k, WOOD)
    for y0, y1 in ((0.3 * k, 3.6 * k), (3.6 * k, 6.8 * k)):                     # the X braces, front and back
        for a, b in (((1, 1), (1, -1)), ((-1, -1), (-1, 1))):
            strut(leg(*a, y0), leg(*b, y1), 0.12 * k, WOOD)
    for y in (0.3 * k, 6.8 * k):                                                  # the girts
        w = (0.8 - y / k * 0.07) * k
        for s2 in (-1, 1):
            box((2 * w + 0.12 * k, 0.12 * k, 0.12 * k), (x0, y, z0 + s2 * w), WOOD)
            box((0.12 * k, 0.12 * k, 2 * w + 0.12 * k), (x0 + s2 * w, y, z0), WOOD)
    cy = H + 0.25 * k
    box((1.0 * k, 0.5 * k, 0.5 * k), (x0 + 0.05 * k, cy, z0), 'slate')         # the head
    with animated('anim_spin:a=x:w=1.4' + tag, (x0 + 0.66 * k * c, cy, z0 - 0.66 * k * s), yaw):   # the wheel turns
        box((0.3 * k, 0.3 * k, 0.3 * k), (x0 + 0.62 * k, cy, z0), 'red')        # the hub
        for b in range(8):                                                       # the blades
            a = b / 8 * 2 * math.pi
            box((0.06 * k, 1.2 * k, 0.3 * k), (x0 + 0.66 * k, cy + math.sin(a) * 0.95 * k, z0 + math.cos(a) * 0.95 * k),
                BLADE, pitch=-(math.pi / 2 - a))
        torus(1.5 * k, 0.07 * k, (x0 + 0.68 * k, cy, z0), WOOD, segs=12, axis='across')
    box((1.8 * k, 0.12 * k, 0.12 * k), (x0 - 1.2 * k, cy, z0), WOOD)            # the tail
    box((1.0 * k, 0.8 * k, 0.08 * k), (x0 - 2.3 * k, cy, z0), 'cream')
    box((0.08 * k, H - 0.6 * k, 0.08 * k), (x0, (H - 0.6 * k) / 2 + 0.3 * k, z0), 'slate')   # the pump rod
    box((0.36 * k, 0.7 * k, 0.36 * k), (x0, 0.35 * k, z0), 'slate')
    box((1.6 * k, 0.14 * k, 0.14 * k), (x0 + 0.8 * k, 0.6 * k, z0), 'slate')
    box((1.0 * k, 0.55 * k, 2.2 * k), (x0 + 1.9 * k, 0.27 * k, z0), WOOD)       # the trough
    box((0.8 * k, 0.05 * k, 2.0 * k), (x0 + 1.9 * k, 0.56 * k, z0), 0x62d3c8)
    if yaw:                                                                      # built facing +X, then turned
        bpy.context.view_layer.update()
        turn = Matrix.Translation(P(x0, 0, z0)) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Translation(-P(x0, 0, z0))
        for o in bpy.context.scene.objects:
            if o not in before and o.parent is None:
                o.matrix_world = turn @ o.matrix_world

@piece(1.0)
@plain
def windpump():
    # Crag: a windpump out on the range, a tree's height, its wheel turning
    # (toward +X, the road) over the round stock tank it fills, and the
    # ranch's cattle come in to it: one drinking at the tank, the rest
    # grazing round it, each of them now and then lifting its head to look
    # about (a gesture, every cow at its own pace: a herd where two looked up
    # and two never did read as two toys). The herd stands at the water
    # rather than alone on the range, where four cows a car long each are a
    # speck from the road: tower, tank and herd read as one scene.
    windpump_body(0.0, 0.0, 0.5)                                                 # a big one, some 16 m
    TX, TZ = 2.0, 1.0
    cyl(0.85, 0.36, (TX, 0, TZ), 'grey', segs=12)                              # the stock tank
    cyl(0.78, 0.04, (TX, 0.33, TZ), 0x62d3c8, segs=12)
    box((0.3, 0.24, 0.3), (-0.9, 0.12, 1.4), 'white')                           # the salt lick
    def toward(x, z, tx, tz):
        return math.atan2(-(tz - z), tx - x)
    cow((3.4, 0, 0.0), yaw=toward(3.4, 0.0, TX, TZ), life='anim_sway:a=z:d=30:p=8.3:r=0.76#d')   # drinking
    cow((0.2, 0, 2.1), yaw=0.3, life='anim_sway:a=z:d=32:p=7.4:r=0.74#a')
    cow((2.8, 0, 2.3), yaw=2.4, coat=0xf8f8fb, life='anim_sway:a=z:d=28:p=9.2:r=0.78#b')
    cow((-1.4, 0, -1.5), yaw=-0.9, coat=0x5a3a28, life='anim_sway:a=z:d=30:p=6.7:r=0.72#e')
    join_still('pump')

def cow(at, yaw=0.0, coat=0x8a5a3c, life=None):
    """A cow the size of one beside a car (about a car long), facing +X
    turned by `yaw`: a block of a body on its legs, a white patch, a white
    face lowered to graze, short horns. `life` names the head's motion,
    hinged at the neck: a gesture (a sway with a rest) lifts it from the
    grass to look about now and then and lowers it again."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    def p(dx, dy, dz):
        return (x + dx * c + dz * s, y + dy, z - dx * s + dz * c)
    for lx in (-0.27, 0.24):                                                    # the legs, a pair to a block
        box((0.1, 0.28, 0.3), p(lx, 0.14, 0), 0x5a4632, yaw=yaw)
    box((0.78, 0.34, 0.38), p(-0.02, 0.44, 0), coat, yaw=yaw)                    # the body
    box((0.3, 0.24, 0.4), p(-0.12, 0.47, 0), 0xf8f8fb, yaw=yaw)                 # a white patch
    def head():
        box((0.3, 0.22, 0.22), p(0.5, 0.4, 0), 0xf8f8fb, yaw=yaw, roll=-0.5)    # the face, lowered to graze
        box((0.12, 0.12, 0.17), p(0.68, 0.28, 0), 0xf2bf99, yaw=yaw)            # the muzzle
        box((0.08, 0.06, 0.4), p(0.46, 0.53, 0), 0xfde4c7, yaw=yaw)             # the horns
    if life:
        with animated(life, p(0.36, 0.5, 0), yaw):
            head()
    else:
        head()

def hay_bale(at, yaw=0.0):
    x, y, z = at
    box((0.6, 0.32, 0.4), (x, y + 0.16, z), 'yellow', yaw=yaw)
    box((0.62, 0.05, 0.08), (x, y + 0.33, z), 'brown', yaw=yaw)

# Crag stands the ranch with its +X 39.1 degrees round from the world's +X
# (its placement's heading); the world's west is this far round from it.
RANCH_WIND_YAW = math.pi - 0.682

@piece(1.0)
def ranch():
    # Crag: the mesa ranch, every building at its own size beside a car (the
    # builder works in world units): the ranch house with its porch and
    # chimney, the red barn with hay stacked by it, the water tower on its
    # braced legs, the windpump turning over its stock tank, and the corral in
    # front toward the road (+X) with cattle in it, grazing, each lifting its
    # head now and then to look about; all on a dirt yard.
    ground_poly([(-7.4, 0.03, -8.6), (3.8, 0.03, -8.6), (3.8, 0.03, 8.8), (-7.4, 0.03, 8.8)], [(0, 1, 2, 3)], 0xd39a70)
    # the house, door toward the road, a porch along its front
    hut(3.0, 1.2, 2.4, (-4.2, 0, -3.8), 0xe3cfa4, 0x8a4a32)
    box((0.9, 0.1, 2.8), (-2.25, 1.15, -3.8), 0x8a4a32, roll=-0.25)
    for z in (-4.95, -3.8, -2.65):
        box((0.1, 1.1, 0.1), (-1.9, 0.55, z), TIMBER)
    box((0.4, 0.9, 0.4), (-5.2, 1.9, -4.6), 0xa96545)                           # the chimney
    # the barn, red with white trim, hay by its door
    hut(3.4, 1.8, 3.0, (-4.4, 0, 4.0), 0xb5443a, 'slate')
    for k, (x, z, y, yw) in enumerate(((-2.2, 5.6, 0, 0.1), (-2.2, 6.3, 0, -0.1), (-2.25, 5.95, 0.32, 0.0))):
        hay_bale((x, y, z), yw)
    # the water tower beside the house
    tx, tz = 1.0, -6.6
    for sx in (-1, 1):
        for sz in (-1, 1):
            strut((tx + sx * 0.62, 0, tz + sz * 0.62), (tx + sx * 0.48, 2.0, tz + sz * 0.48), 0.14, TIMBER)
    for s in (-1, 1):
        strut((tx + s * 0.6, 0.2, tz - 0.6), (tx + s * 0.5, 1.8, tz + 0.5), 0.08, TIMBER)
        strut((tx - 0.6, 0.2, tz + s * 0.6), (tx + 0.5, 1.8, tz + s * 0.5), 0.08, TIMBER)
    box((1.4, 0.12, 1.4), (tx, 2.02, tz), TIMBER)
    cyl(0.72, 1.0, (tx, 2.08, tz), 0x9a7b55, segs=12)
    for y in (2.3, 2.75):
        cyl(0.75, 0.07, (tx, y, tz), 0x5a4632, segs=12)
    cyl(0.84, 0.55, (tx, 3.08, tz), 0x6e5b3a, r2=0.08, segs=12)
    box((0.12, 1.9, 0.12), (tx + 0.5, 0.95, tz + 0.2), 'slate')                # its downpipe to a trough
    box((0.5, 0.3, 0.9), (tx + 1.0, 0.15, tz + 0.2), TIMBER)
    for i in range(5):                                                           # a ladder up a leg
        box((0.06, 0.06, 0.34), (tx - 0.62, 0.35 + i * 0.36, tz - 0.3), TIMBER)
    # the windpump over the stock tank, across the yard. Its wheel faces the
    # wind that blows the sand east across every canyon map (the ambient's
    # +X drift, the clouds' too), so it looks west: RANCH_WIND_YAW turns it
    # from the ranch's +X (the road) as Crag stands it (tracks.js crag set).
    windpump_body(1.6, 6.8, 0.42, tag='#w', yaw=RANCH_WIND_YAW)
    wx, wz = 1.6 + math.cos(RANCH_WIND_YAW), 6.8 - math.sin(RANCH_WIND_YAW)
    cyl(0.75, 0.32, (wx, 0, wz), 'grey', segs=12)
    cyl(0.68, 0.04, (wx, 0.3, wz), 0x62d3c8, segs=12)
    # the corral toward the road: posts and two rails, its gate open on +X
    X0, X1, Z0, Z1 = -1.4, 3.2, -2.0, 2.0
    posts = [(X0 + (X1 - X0) * i / 2, Z0) for i in range(3)] + [(X1, Z0 + (Z1 - Z0) * i / 4) for i in range(1, 5)] \
        + [(X1 - (X1 - X0) * i / 2, Z1) for i in range(1, 3)] + [(X0, 0.0)]
    for x, z in posts:
        box((0.12, 0.5, 0.12), (x, 0.25, z), TIMBER)
    loop = posts + posts[:1]
    for a, b in zip(loop, loop[1:]):
        if a[0] == X1 and b[0] == X1 and min(a[1], b[1]) >= 0.0 and max(a[1], b[1]) <= 1.0:
            continue                                                             # the gateway
        L = math.dist(a, b)
        for y in (0.2, 0.42):
            box((0.05, 0.07, L), ((a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2), 0x9a7b55, yaw=math.atan2(b[0] - a[0], b[1] - a[1]))
    box((0.05, 0.07, 1.0), (X1 + 0.45, 0.32, 1.0), 0x9a7b55, yaw=1.2)             # the gate, swung open
    box((0.5, 0.25, 1.1), (X0 + 0.5, 0.12, -1.2), 'grey')                         # a trough, a hay feeder
    box((0.4, 0.03, 1.0), (X0 + 0.5, 0.25, -1.2), 0x62d3c8)
    hay_bale((X0 + 0.6, 0, 1.2), 0.3)
    cow((0.4, 0, -0.6), yaw=0.4, life='anim_sway:a=z:d=30:p=7.1:r=0.72#d')
    cow((1.7, 0, 0.9), yaw=2.6, coat=0x5a3a28, life='anim_sway:a=z:d=32:p=8.6:r=0.74#c')
    cow((2.2, 0, -1.2), yaw=-1.2, coat=0xf8f8fb, life='anim_sway:a=z:d=28:p=9.7:r=0.78#e')
    join_still('ranch')

@piece(1.0)
def ranch_fence():
    # Crag: the ranch's range fence along the start straight (+X the road,
    # Z along it), post and two rails at a real fence's height, 36 units of
    # it with the ranch's gateway in the middle: two tall posts under a
    # cross beam, a board hanging from it, the gate swung open (the herd
    # inside it is set-ranch-herd). It drapes: every post stands on the
    # ground as drawn. The start is open range to the skyline, not a canyon.
    def fence():
        zs = [-18.0 + 2.0 * i for i in range(19)]
        for z in zs:
            if abs(z) < 1.5:
                continue
            box((0.1, 0.56, 0.1), (0, 0.28, z), TIMBER)
        for a, b in zip(zs, zs[1:]):
            if abs((a + b) / 2) < 2.0:
                continue                                                          # the gateway
            for y in (0.22, 0.46):
                box((0.05, 0.07, b - a), (0, y, (a + b) / 2), 0x9a7b55)
        for z in (-2.0, 2.0):                                                     # the gateway's posts and beam
            box((0.16, 2.3, 0.16), (0, 1.15, z), TIMBER)
        box((0.14, 0.14, 4.6), (0, 2.25, 0), TIMBER)
        box((0.05, 0.4, 1.5), (0, 1.9, 0), 0x9a7b55)                              # the ranch's board
        box((0.06, 0.1, 1.1), (0.01, 1.9, 0), 0xfde4c7)
        for y in (0.22, 0.46):                                                    # the gate, swung in
            box((1.9, 0.07, 0.05), (-0.95, y, -2.0), 0x9a7b55)
        box((0.07, 0.5, 0.07), (-1.9, 0.27, -2.0), 0x9a7b55)
    with plain_parts():
        draped('fence', fence)

def loft(path, radii, color, side=(0.0, 0.0, 1.0), n=6, turn=0.0):
    """A faceted limb through glTF `path`, an ellipse in section at each
    point (`radii`: half its width along `side`, half its depth across it),
    `n` facets round, closed at both ends: a barrel, a neck, a leg with its
    joints. `turn` turns the facets about the limb (half a facet stands a
    four-sided leg square on)."""
    import bmesh
    u = Vector(side).normalized()
    pts = [Vector(p) for p in path]
    bm = bmesh.new()
    rings = []
    for i, (p, (rw, rd)) in enumerate(zip(pts, radii)):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        v = u.cross(t).normalized()
        w = t.cross(v).normalized()                              # across the limb, square to its run
        rings.append([bm.verts.new(P(*(p + w * (rw * math.cos(turn + 2 * math.pi * k / n))
                                       + v * (rd * math.sin(turn + 2 * math.pi * k / n))))) for k in range(n)])
    for a, b in zip(rings, rings[1:]):
        for k in range(n):
            bm.faces.new((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('loft')
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new('loft', me)
    bpy.context.scene.collection.objects.link(o)
    return paint(o, color)

def range_cow(at, yaw=0.0, coat=0x8a5a3c, patch=None, face=0xf8f8fb, k=1.0, pose='graze', life=None):
    """One of the ranch's cattle at its own size (about a car long at k 1; a
    calf at 0.55), facing +X turned by `yaw`, the horses' faceted build: a
    deep square barrel, short legs, a broad face (`face`: a Hereford's
    white, or the coat's), stub horns, a tail with its switch. `patch`
    saddles it with a second colour. `pose`: `graze` (head at the grass),
    `up` (looking about) or `lie` (legs folded under, chewing). `life`
    hinges the head and neck."""
    x, y, z = at
    c, s = math.cos(yaw), math.sin(yaw)
    side = (s, 0.0, c)
    lie = pose == 'lie'
    drop = 0.2 if lie else 0.0
    def p(dx, dy, dz=0.0):
        return (x + (dx * c + dz * s) * k, y + (dy - drop) * k, z + (-dx * s + dz * c) * k)
    def r(*pairs):
        return [(a * k, b * k) for a, b in pairs]
    loft([p(-0.4, 0.46), p(-0.3, 0.47), p(0.0, 0.44), p(0.24, 0.45), p(0.34, 0.47)],
         r((0.1, 0.1), (0.17, 0.17), (0.18, 0.19), (0.165, 0.18), (0.1, 0.11)), coat, side, 6)
    if patch:
        loft([p(-0.16, 0.47), p(0.0, 0.455), p(0.12, 0.46)], r((0.176, 0.176), (0.186, 0.196), (0.176, 0.19)), patch, side, 6)
    for lx, lz in ((0.24, -0.1), (0.24, 0.1), (-0.3, -0.1), (-0.3, 0.1)):
        if lie:                                                                  # folded under
            loft([p(lx, 0.3, lz * 1.3), p(lx + 0.16, 0.235, lz * 1.5)], r((0.045, 0.05), (0.035, 0.035)), coat, side, 4)
            continue
        loft([p(lx, 0.36, lz), p(lx + (0.0 if lx > 0 else -0.03), 0.19, lz), p(lx, 0.05, lz)],
             r((0.055, 0.065), (0.038, 0.04), (0.032, 0.034)), coat, side, 4, turn=math.pi / 4)
        loft([p(lx, 0.05, lz), p(lx + 0.01, 0.0, lz)], r((0.036, 0.038), (0.042, 0.046)), 0x38383d, side, 4, turn=math.pi / 4)
    loft([p(-0.4, 0.55), p(-0.45, 0.5), p(-0.46, 0.28), p(-0.45, 0.14)],
         r((0.018, 0.02), (0.02, 0.022), (0.016, 0.018), (0.03, 0.034)), 0x5a4632, side, 4, turn=math.pi / 4)
    HX, HY = 0.3, 0.5
    dip = {'graze': -0.95, 'up': 0.15, 'lie': 0.1}[pose]
    cd, sd = math.cos(dip), math.sin(dip)
    def q(dx, dy, dz=0.0):
        ax, ay = dx - HX, dy - HY
        return p(HX + ax * cd - ay * sd, HY + ax * sd + ay * cd, dz)
    def head():
        loft([q(0.28, 0.5), q(0.42, 0.55), q(0.5, 0.58)], r((0.1, 0.13), (0.075, 0.1), (0.07, 0.085)), coat, side, 6)
        loft([q(0.47, 0.6), q(0.58, 0.55), q(0.66, 0.5)], r((0.085, 0.085), (0.07, 0.075), (0.055, 0.055)), face, side, 6)
        loft([q(0.64, 0.51), q(0.7, 0.475)], r((0.055, 0.052), (0.05, 0.045)), 0xf2bf99, side, 6)
        with plain_parts():
            box((0.05 * k, 0.045 * k, 0.3 * k), q(0.47, 0.67), 0xfde4c7, yaw=yaw)             # the horns
            box((0.05 * k, 0.07 * k, 0.26 * k), q(0.44, 0.61), coat, yaw=yaw)                 # the ears
    if life:
        with animated(life, p(HX, HY), yaw):
            head()
    else:
        head()

# The ranch's herd on the range by the start (Crag): a dozen head and their
# calves in loose bunches, each (x, z, yaw, coat, patch, face, size, pose);
# Herefords red with white faces, a few black baldies and roans among them.
RED, BLACK, ROAN, CREAM_HIDE = 0x9a4a32, 0x38383d, 0xb06041, 0xf2bf99
HERD_A = ((-1.2, -13.5, 0.4, RED, None, 0xf8f8fb, 1.0, 'graze'), (-2.6, -12.0, 2.2, RED, 0xf8f8fb, 0xf8f8fb, 0.95, 'up'),
          (-3.9, -14.2, -0.6, BLACK, None, 0xf8f8fb, 1.0, 'graze'), (-2.9, -10.6, 1.6, RED, None, 0xf8f8fb, 0.55, 'up'),
          (-5.6, -6.0, 3.3, ROAN, CREAM_HIDE, ROAN, 1.05, 'lie'), (-4.4, -4.6, -2.4, RED, None, 0xf8f8fb, 1.0, 'lie'),
          (-6.4, -3.4, 0.9, BLACK, None, BLACK, 0.95, 'graze'),
          (-1.4, 2.6, -1.0, RED, None, 0xf8f8fb, 1.0, 'up'), (-2.9, 4.4, 0.2, ROAN, None, 0xf8f8fb, 0.9, 'graze'),
          (-1.9, 5.6, 2.7, RED, 0xf8f8fb, 0xf8f8fb, 0.55, 'graze'),
          (-5.2, 9.5, -0.3, BLACK, 0xf8f8fb, 0xf8f8fb, 1.0, 'graze'), (-3.6, 11.6, 1.9, RED, None, 0xf8f8fb, 1.0, 'graze'),
          (-6.6, 12.8, 3.6, RED, None, 0xf8f8fb, 0.95, 'up'), (-1.6, 14.4, -1.9, ROAN, CREAM_HIDE, 0xf8f8fb, 1.0, 'lie'))
HERD_B = ((-2.0, -6.0, 1.2, RED, None, 0xf8f8fb, 1.0, 'graze'), (-3.4, -4.4, -0.4, BLACK, None, 0xf8f8fb, 1.0, 'up'),
          (-2.6, 1.8, 2.6, RED, 0xf8f8fb, 0xf8f8fb, 0.95, 'graze'), (-3.9, 3.0, 0.8, RED, None, 0xf8f8fb, 0.55, 'up'),
          (-5.4, 7.6, -1.2, ROAN, None, ROAN, 1.0, 'lie'))

def herd(cattle):
    """A bunch of range cattle as ONE draped part (each stands on the land as
    drawn), every third one's head alive: a gesture, lifting to look about
    or dipping to the grass. The lite build stands every other one."""
    def build():
        for i, (x, z, yaw, coat, patch, face, size, pose) in enumerate(cattle):
            if LITE and i % 2:
                continue
            life = None
            if i % 3 == 0 and pose != 'lie':
                life = 'anim_drape+sway:a=z:d=30:p=%.1f:r=0.76#h%d' % (7.0 + 0.7 * (i % 5), i)
            range_cow((0.7 * x, 0, z), yaw, coat, patch, face, 1.25 * size, pose, life)   # bunched toward the fence, a size up to read over its rails
    draped('herd', build)

@piece(1.0)
def ranch_herd():
    herd(HERD_A)

@piece(1.0)
def ranch_herd_east():
    herd(HERD_B)

@piece(1.0)
def crag_saguaros():
    # Crag: a stand of saguaros by the start straight, three of them and an
    # ocotillo among brush and barrel cacti, green against the plain and the
    # sky (the stand that stood here before the rim came to the verge read as
    # the start's landmark). They drape, so they stand on the ground as drawn.
    def stand():
        saguaro((0.0, 0, 0.0), 4.6, arms=((0.3, 0.36, 0.42), (3.5, 0.48, 0.36), (1.9, 0.6, 0.26)), bloom=True)
        saguaro((1.3, 0, -1.6), 3.3, arms=((2.2, 0.45, 0.36),))
        saguaro((-1.2, 0, 2.0), 2.6, arms=((4.6, 0.5, 0.34),))
        ocotillo((1.6, 0, 1.4), 1.8, seed=2)
        brush((-1.4, 0, -1.1), 0.9)
        brush((2.4, 0, 0.3), 0.7, yaw=1.1)
        barrel_cactus((0.6, 0, 2.6), 1.1)
        barrel_cactus((-0.4, 0, -2.4), 0.9)
    draped('cacti', stand)

@piece(1.0)
@plain
def hoodoos():
    # Crag: hoodoos, three spires of the buttes' own rock (five to nine units
    # tall, one colour each) on one apron of their talus: the stacked blocks
    # they were read as toy totems beside the buttes.
    crag_butte(((0.0, 0.0, 9.0, 2.6, 2.2, 0.3, 0.0, 0.5), (3.6, 2.4, 6.5, 2.4, 2.0, -0.4, 0.0, 0.5),
                (-3.0, 2.8, 5.0, 2.2, 1.9, 0.9, 0.0, 0.5)), 1.2, 3.5, 12.0, 4.4, jag=0.12)
    crag_rubble(((-5.5, -3.5, 0.5),))

# The canyons' mountainsides: the rock a canyon road is cut through, rising
# from its verge as a mountain does, not as a wall. Terrain cannot rise at the
# kerb (a 9 u grid under the deck cap), so the near slope is geometry and the
# track's own ridges carry the range on behind it. Per column along the road
# the profile is a talus apron off the verge, then strata that each stand as
# a short battered cliff with a bench on top, stepping back, then the slope to
# an irregular crest of peaks and saddles, and the back falling into the land
# behind. The strata are level (a saddle cuts down through them, as erosion
# does) and coloured band by band; every vertex is jittered, so no face is a
# flat slab. Each length is its own seed: its crest, its benches and its foot
# never repeat, and both ends fall away to the verge, so lengths laid
# overlapping read as one range with a saddle between summits, and the last
# one of a run ends as a mountain ends. `R` bends the foot round a curve of
# that radius, the road's centre on the +X side (the outside of a bend) or,
# negative, behind (the inside). Each length DRAPES: every vertex rides the
# land under it.
MTN_BANDS = (2.3, 3.9, 5.6, 7.5)                         # the benches' heights, before their wobble
MTN_CLIFF = ('brown', 'salmon', 'brown', 'salmon', 'brown')   # each stratum's face, foot up

def canyon_mountain(seed, L, H, R=0.0, D=13.0):
    import random
    rnd = random.Random(seed)
    def noise(waves):
        ph = [(rnd.uniform(0.0, 2 * math.pi), lam, a) for lam, a in waves]
        tot = sum(a for _, _, a in ph)
        return lambda s: sum(a * math.sin(2 * math.pi * s / lam + p) for p, lam, a in ph) / tot
    def smooth(t):
        t = max(0.0, min(1.0, t))
        return t * t * (3 - 2 * t)
    def jit(*k):
        v = math.sin(sum(c * m for c, m in zip(k, (12.9898, 78.233, 37.719))) + seed * 4.1) * 43758.5453
        return v - math.floor(v) - 0.5
    n_crest = noise(((L * 0.83, 1.0), (L * 0.37, 0.75), (L * 0.16, 0.35)))
    n_back = noise(((L * 0.61, 1.0), (L * 0.23, 0.5)))
    n_foot = noise(((7.5, 1.0), (3.4, 0.4)))
    n_bench = [noise(((L * 0.47, 1.0), (7.1, 0.5))) for _ in MTN_BANDS]
    n_wob = [noise(((L * 0.9, 1.0), (4.3, 0.4))) for _ in MTN_BANDS]
    dip = rnd.uniform(-0.05, 0.05)
    # gullies cut back into the face about every 7 u, each spilling a scree
    # fan over the talus at its mouth
    nf = max(1, int(L / 7))
    fans = [-L / 2 + L * (k + 0.5 + 0.5 * (rnd.random() - 0.5)) / nf for k in range(nf)]
    deep = [rnd.uniform(1.4, 2.4) for _ in fans]
    nz = max(9, int(round(L / 1.45)) + 1)
    ss = [-L / 2 + L * i / (nz - 1) for i in range(nz)]
    def world(x, y, s):
        if not R:
            return (x, y, s)
        a, r = s / R, R - x
        return (R - r * math.cos(a), y, r * math.sin(a))
    cols = []
    for i, s in enumerate(ss):
        end = min(s + L / 2, L / 2 - s)
        taper = 0.08 + 0.92 * smooth(end / 4.5)
        hc = max(0.35, H * (0.5 + 0.5 * (0.5 + 0.5 * n_crest(s)) ** 1.3) * taper)
        hc += 0.5 * jit(i, 7) * taper
        xf = 0.6 * n_foot(s) - 1.4 * (1 - taper)           # buttresses and gullies; a tail draws back
        xc = xf - (1.6 + 0.6 * hc + 0.9 * (0.5 + 0.5 * n_back(s)))
        crest = (xc + 0.4 * jit(i, 8), hc)
        fan = taper * max(math.exp(-((s - f) / 1.9) ** 2) for f in fans)
        gully = taper * max(d * math.exp(-((s - f) / 1.5) ** 2) for f, d in zip(fans, deep))
        hc -= 0.5 * gully
        talus = min(0.85 + 1.2 * fan, MTN_BANDS[0] - 0.5, hc - 0.05)
        pts = [(min(xf + 0.8 + 0.5 * fan, 1.3), -0.6), (xf + 0.15 + 0.3 * fan + 0.2 * jit(i, 1), talus)]
        x, y = pts[-1]
        for b, y0 in enumerate(MTN_BANDS):
            yt = y0 + 0.45 * n_wob[b](s) + dip * s + 0.06 * jit(i, 2, b)
            if yt > hc - 0.45:
                pts += [crest, crest]
                x, y = crest
                continue
            cx = x - 0.38 * (yt - y) + 0.15 * jit(i, 3, b)  # the cliff, battered and broken
            bx = max(cx - (0.6 + 1.5 * (0.5 + 0.5 * n_bench[b](s))), xc + 0.5)
            pts += [(cx, yt), (bx, yt + 0.12 + 0.05 * jit(i, 4, b))]
            x, y = pts[-1]
        pts.append(crest)
        pts.append((-D * (0.25 + 0.75 * taper), -1.0))      # the back, sunk in the land behind
        pts = pts[:1] + [(px - gully * smooth((py - 0.4) / 3.5), py) for px, py in pts[1:-1]] + pts[-1:]
        cols.append([world(px, py, s) for px, py in pts])
    def strip(r, color):
        verts, faces = [], []
        for i in range(nz - 1):
            q = [cols[i][r], cols[i + 1][r], cols[i + 1][r + 1], cols[i][r + 1]]
            if q[0] == q[3] and q[1] == q[2]:
                continue                                    # a stratum the crest cut away
            faces.append(tuple(range(len(verts), len(verts) + 4)))
            verts += q
        if not faces:
            return
        me = bpy.data.meshes.new('mtn')
        me.from_pydata([tuple(P(*v)) for v in verts], [], faces)
        me.update()
        for p in me.polygons:                               # outward: nothing overhangs, so up
            if p.normal.z < 0:
                p.flip()
        ob = bpy.data.objects.new('mtn', me)
        bpy.context.scene.collection.objects.link(ob)
        paint(ob, color)
    rows = len(cols[0])
    strip(0, 'salmon')                                      # the talus off the verge
    for b in range(len(MTN_BANDS)):
        strip(1 + 2 * b, MTN_CLIFF[b])                      # the stratum's cliff
        strip(2 + 2 * b, 'tan')                             # the bench on it
    strip(rows - 3, MTN_CLIFF[len(MTN_BANDS)])              # the last slope to the crest
    strip(rows - 2, 'salmon')                               # the back
    for i, out in ((0, -1), (nz - 1, 1)):                   # the two tails' sections
        c = [p for k, p in enumerate(cols[i]) if k == 0 or p != cols[i][k - 1]]
        sect = c + [(c[-1][0], -1.0, c[-1][2]), (c[0][0], -1.0, c[0][2])]
        me = bpy.data.meshes.new('cap')
        me.from_pydata([tuple(P(*v)) for v in sect], [], [tuple(range(len(sect)))])
        me.update()
        along = Vector(P(*cols[i][0])) - Vector(P(*cols[i - out][0]))
        if me.polygons[0].normal.dot(along) < 0:
            me.polygons[0].flip()
        ob = bpy.data.objects.new('cap', me)
        bpy.context.scene.collection.objects.link(ob)
        paint(ob, 'salmon')
    with plain_parts():
        # blocks fallen off the cliffs onto the talus
        for k in range(max(2, int(L / 6))):
            s = -L / 2 + L * (k + 0.5 + 0.6 * jit(k, 9)) / max(2, int(L / 6))
            if min(s + L / 2, L / 2 - s) < 3.0:
                continue
            q = 0.45 + 0.35 * (jit(k, 10) + 0.5)
            px, _, pz = world(0.6 * n_foot(s) + 0.25, 0.0, s)
            box((q * 1.4, q * 0.8, q * 1.1), (px, q * 0.25, pz), 'salmon', yaw=3.0 * jit(k, 11), roll=0.2 * jit(k, 12))
    group([o for o in bpy.context.scene.objects if o.type == 'MESH'], 'drape_wall')

def mountains(**lengths):
    """One piece per length: its name, and canyon_mountain's arguments."""
    for name, kw in lengths.items():
        def build(kw=kw):
            canyon_mountain(**kw)
        build.__name__ = name
        piece(1.0)(build)

# Wash's start canyon: the outer range down the straight, round the bend and
# on, lower spurs on the inside of the straight and after the bend.
mountains(canyon_peaks_a=dict(seed=7, L=21.0, H=10.0),
          canyon_peaks_b=dict(seed=19, L=26.0, H=9.5),
          canyon_peaks_c=dict(seed=23, L=26.0, H=10.5),
          canyon_bend_wash=dict(seed=31, L=34.0, H=10.5, R=14.8),
          canyon_spur_a=dict(seed=41, L=24.0, H=6.5, D=10.0),
          canyon_spur_b=dict(seed=43, L=22.0, H=6.0, D=10.0))

# Gulch's descent: round the outside of the long left-hander off the crest,
# down the short straight and round the tight bend into the mine yard (with
# Wash's straight lengths between), and the inside's face round the
# left-hander, its back falling into the middle of the loop (the land there
# sits under the deck cap and cannot rise), which opens on the yard.
mountains(canyon_bend_gulch=dict(seed=53, L=36.0, H=10.5, R=28.2),
          canyon_hairpin_gulch=dict(seed=59, L=24.0, H=9.5, R=15.8),
          canyon_inside_gulch=dict(seed=61, L=30.0, H=9.0, R=-17.8, D=13.0))

# Crag's rim: round the outside of the west hairpin (its entry looser than its
# apex, so a wide bend's foot follows it) and out of it, and along the north
# straight to the bridge. The start straight before it is open range.
mountains(canyon_hairpin_crag=dict(seed=73, L=30.0, H=10.5, R=24.0),
          canyon_exit_crag=dict(seed=79, L=20.0, H=9.5, R=14.0),
          canyon_rim_crag_b=dict(seed=83, L=20.0, H=9.0))

# ---- stepped rock: a mountain cut into level strata --------------------------------
#
# The canyon's mountains are a smooth height M(x, z) cut into level strata.
# Each stratum is the outline where M rises past it (marching squares over a
# fine grid, simplified to facets a couple of units long and weathered in and
# out), stood up as a cliff one stratum tall and capped by a bench set back
# from its edge. So the rock steps back as it climbs, into as many peaks and
# ridges as M has, and its outline is its own at every level: no block
# repeated, no face one flat slab.

def hash1(x, z, k=0.0):
    """A repeatable number in [-1, 1) for a point."""
    v = math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453
    return 2.0 * (v - math.floor(v)) - 1.0

def contour_rings(F, xs, zs, level):
    """The outlines of F >= level over a grid (F[j][i] at (xs[i], zs[j])) as
    closed rings of (x, z), each with the inside on its left in the (x, z)
    plane. The grid's border must lie outside, so every ring closes."""
    T = {1: (0, 3), 2: (1, 0), 3: (1, 3), 4: (2, 1), 6: (2, 0), 7: (2, 3), 8: (3, 2), 9: (0, 2),
         11: (1, 2), 12: (3, 1), 13: (0, 1), 14: (3, 0)}
    nxt = {}
    for j in range(len(zs) - 1):
        r0, r1 = F[j], F[j + 1]
        for i in range(len(xs) - 1):
            c = (r0[i] >= level) | (r0[i + 1] >= level) << 1 | (r1[i + 1] >= level) << 2 | (r1[i] >= level) << 3
            if c in (0, 15):
                continue
            e = ((0, i, j), (1, i + 1, j), (0, i, j + 1), (1, i, j))
            if c in (5, 10):
                mid = (r0[i] + r0[i + 1] + r1[i] + r1[i + 1]) / 4 >= level
                pairs = {(5, True): ((0, 1), (2, 3)), (5, False): ((0, 3), (2, 1)),
                         (10, True): ((3, 0), (1, 2)), (10, False): ((1, 0), (3, 2))}[(c, mid)]
            else:
                pairs = (T[c],)
            for a, b in pairs:
                nxt[e[a]] = e[b]
    def point(k):
        h, i, j = k
        if h == 0:
            fa, fb = F[j][i], F[j][i + 1]
            return (xs[i] + (xs[i + 1] - xs[i]) * (level - fa) / (fb - fa), zs[j])
        fa, fb = F[j][i], F[j + 1][i]
        return (xs[i], zs[j] + (zs[j + 1] - zs[j]) * (level - fa) / (fb - fa))
    rings = []
    while nxt:
        k0 = next(iter(nxt))
        ring, k = [point(k0)], nxt.pop(k0)
        while k != k0:
            ring.append(point(k))
            k = nxt.pop(k)
        rings.append(ring)
    return rings

def ring_area(r):
    return 0.5 * sum(r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1] for i in range(len(r)))

def _dp(pts, tol):
    """Douglas-Peucker on an open run of points."""
    if len(pts) < 3:
        return list(pts)
    (ax, az), (bx, bz) = pts[0], pts[-1]
    dx, dz = bx - ax, bz - az
    L = math.hypot(dx, dz) or 1e-9
    k, best = 0, -1.0
    for i in range(1, len(pts) - 1):
        d = abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L
        if d > best:
            k, best = i, d
    if best <= tol:
        return [pts[0], pts[-1]]
    return _dp(pts[:k + 1], tol)[:-1] + _dp(pts[k:], tol)

def rock_ring(ring, tol, step, jitter, seed, keep=None):
    """A contour as a cliff's foot: simplified to `tol`, no facet longer than
    `step`, every corner pushed out or in along its normal by up to `jitter`
    (a weathered edge). `keep(q)` may move a corner back where it must not go."""
    k = max(range(len(ring)), key=lambda i: (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2)
    pts = _dp(ring[:k + 1], tol)[:-1] + _dp(ring[k:] + [ring[0]], tol)[:-1]
    out = []
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        n = max(1, int(math.ceil(math.hypot(b[0] - a[0], b[1] - a[1]) / step)))
        out += [(a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n) for t in range(n)]
    res = []
    for i, p in enumerate(out):
        a, b = out[i - 1], out[(i + 1) % len(out)]
        tx, tz = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, tz) or 1.0
        j = jitter * hash1(p[0], p[1], seed)
        q = (p[0] + j * tz / L, p[1] - j * tx / L)            # outward: the inside is on the left
        res.append(keep(q) if keep else q)
    return res

def inset_ring(ring, d):
    """The ring moved inward, each corner along its mitre by d (a number, or
    d(x, z) per corner: a facet whose corners move alike stays parallel to
    the one below it)."""
    n, out = len(ring), []
    for i in range(n):
        a, p, b = ring[i - 1], ring[i], ring[(i + 1) % n]
        ns = []
        for u, v in ((a, p), (p, b)):
            tx, tz = v[0] - u[0], v[1] - u[1]
            L = math.hypot(tx, tz) or 1.0
            ns.append((-tz / L, tx / L))
        c = max(0.35, 1.0 + ns[0][0] * ns[1][0] + ns[0][1] * ns[1][1])
        k = d(*p) if callable(d) else d
        out.append((p[0] + k * (ns[0][0] + ns[1][0]) / c, p[1] + k * (ns[0][1] + ns[1][1]) / c))
    return out

def inside_ring(p, r):
    """Whether point p lies inside ring r (even-odd)."""
    x, z, hit = p[0], p[1], False
    for i in range(len(r)):
        (ax, az), (bx, bz) = r[i - 1], r[i]
        if (az > z) != (bz > z) and x < ax + (z - az) * (bx - ax) / (bz - az):
            hit = not hit
    return hit

def strata_band(bottoms, y0, y1, d, color, dark=None, floor=False, peaks=()):
    """One stratum: each ring of `bottoms` stood up from y0 as a cliff to y1,
    its top edge set back `d` and capped there (a bench), or, for a ring in
    `peaks` (no stratum above it), drawn up to a point: a summit, not a
    table; `floor` also closes it underneath (where it roofs a tunnel). A
    wall facet whose middle `dark` picks, and the floor, are a second part
    shaded down the swatch's whole ramp: rock out of the sun (the sun bake
    darkens what a piece shades, not the piece). Returns the parts."""
    import bmesh
    lit, shut = bmesh.new(), bmesh.new()
    tops = [inset_ring(r, d) for r in bottoms]
    for r, t in zip(bottoms, tops):
        n = len(r)
        for i in range(n):
            k = (i + 1) % n
            mx, mz = (r[i][0] + r[k][0]) / 2, (r[i][1] + r[k][1]) / 2
            bm = shut if dark and dark(mx, mz) else lit
            vs = [bm.verts.new(P(r[i][0], y0, r[i][1])), bm.verts.new(P(r[k][0], y0, r[k][1])),
                  bm.verts.new(P(t[k][0], y1, t[k][1])), bm.verts.new(P(t[i][0], y1, t[i][1]))]
            f = bm.faces.new(vs)
            f.normal_update()
            tx, tz = r[k][0] - r[i][0], r[k][1] - r[i][1]
            if f.normal.dot(P(tz, 0.0, -tx)) < 0:                # outward: the inside is on the left
                f.normal_flip()
    def fill(bm, rings, y, up):
        edges = []
        for r in rings:
            vs = [bm.verts.new(P(x, y, z)) for x, z in r]
            edges += [bm.edges.new((vs[i - 1], vs[i])) for i in range(len(vs))]
        made = bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)
        for f in made['geom']:
            if isinstance(f, bmesh.types.BMFace):
                f.normal_update()
                if (f.normal.z < 0) == up:
                    f.normal_flip()
    flat = [t for k, t in enumerate(tops) if k not in peaks]
    if flat:
        fill(lit, flat, y1, True)
    for k in peaks:
        t = tops[k]
        cx, cz = sum(p[0] for p in t) / len(t), sum(p[1] for p in t) / len(t)
        apex = lit.verts.new(P(cx, y1 + min(4.0, 0.6 * math.sqrt(abs(ring_area(t)))), cz))
        for i in range(len(t)):
            f = lit.faces.new((lit.verts.new(P(t[i - 1][0], y1, t[i - 1][1])), lit.verts.new(P(t[i][0], y1, t[i][1])), apex))
            f.normal_update()
            if f.normal.z < 0:
                f.normal_flip()
    if floor:
        fill(shut, bottoms, y0, False)
    parts = []
    for bm, tag in ((lit, 'lit'), (shut, 'shut')):
        if not bm.faces:
            bm.free()
            continue
        me = bpy.data.meshes.new('stratum_' + tag)
        bm.to_mesh(me)
        bm.free()
        o = bpy.data.objects.new('stratum_' + tag, me)
        bpy.context.scene.collection.objects.link(o)
        if tag == 'shut':
            paint(o, 0xa96545)                    # every band's rock the same brown in there
            o['ramp'] = 1.6
        else:
            paint(o, color)
        parts.append(o)
    return parts

def strata_massif(M, x0, x1, z0, z1, bands, corridor=None, grid=0.5, tol=0.35, step=2.6, jitter=0.3, summits=True):
    """A mountain of level strata over M(x, z) on [x0, x1] x [z0, z1]:
    `bands` is ((y0, y1, colour, setback), ...) from the foot up. The first
    band's foot is where M passes 0 (the band starts sunk), every other's
    where M passes 0.3 of the way up it. With `corridor` = (W, roof) the
    road runs along z at x = 0 through every band below `roof` in a cut W
    either side, its walls never weathered into it, and the band from `roof`
    up is closed underneath: a tunnel wherever M stands over the road past
    that band's foot, its facets shut from the sun. Returns the tunnel's
    (z0, z1), or None."""
    nx, nz = int(round((x1 - x0) / grid)) + 1, int(round((z1 - z0) / grid)) + 1
    xs = [x0 + grid * i for i in range(nx)]
    zs = [z0 + grid * j for j in range(nz)]
    base = [[M(x, z) for x in xs] for z in zs]
    for j in range(nz):
        base[j][0] = base[j][-1] = -1e9
    base[0] = base[-1] = [-1e9] * nx
    level = lambda bi: 0.0 if bi == 0 else bands[bi][0] + 0.3 * (bands[bi][1] - bands[bi][0])
    W, roof = corridor or (0.0, 1e9)
    rb = next((i for i, b in enumerate(bands) if b[0] >= roof - 1e-6), None)
    tunnel, dark, parts = None, None, []
    if corridor:
        i0 = min(range(nx), key=lambda i: abs(xs[i]))
        over = [zs[j] for j in range(nz) if base[j][i0] >= level(rb)]
        if over:
            tunnel = (min(over), max(over))
            dark = lambda x, z: abs(x) < W + 1.0 and tunnel[0] - 0.5 < z < tunnel[1] + 0.5
    every = []
    for bi, (y0, y1, col, back) in enumerate(bands):
        low = corridor is not None and y1 <= roof + 1e-6
        F = [[min(v, 8.0 * (abs(x) - W)) for x, v in zip(xs, row)] for row in base] if low else base
        # a corner weathered into the corridor goes as far back out of it
        keep = (lambda q: (math.copysign(2 * W - abs(q[0]), q[0]) if abs(q[0]) < W else q[0], q[1])) if low else None
        # facets longer up the mountain, where no racer comes near them
        every.append([rock_ring(r, tol, step * (1.0 if low else 1.25), jitter * (1.5 if low else 1.0), bi * 7.1, keep)
                      for r in contour_rings(F, xs, zs, level(bi)) if abs(ring_area(r)) > 4.0])
    for bi, (y0, y1, col, back) in enumerate(bands):
        above = every[bi + 1] if bi + 1 < len(every) else []
        # a ring with nothing standing on it is a summit, drawn up to a point
        # over its middle (only a ring that holds its middle: a crescent's
        # point would stand off it)
        peaks = [k for k, r in enumerate(every[bi]) if summits and not any(inside_ring(p, r) for q in above for p in q)
                 and inside_ring((sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r)), r)]
        low = corridor is not None and y1 <= roof + 1e-6
        # The setback, corner by corner, against the contours' spacing there
        # (how far in the stratum above stands): a cliff (back >= 0) steps
        # back that much, never past most of that way; a slope (back < 0)
        # lies back -back of it, so it follows the mountain, steep where M is
        # steep and gentle where it is gentle. No stratum overhangs the one below.
        gap = (level(bi + 1) if bi + 1 < len(bands) else y1 + 1.0) - level(bi)
        F = (lambda x, z: min(M(x, z), 8.0 * (abs(x) - W))) if low else M
        def setback(x, z, F=F, gap=gap, back=back):
            g = math.hypot(F(x + 0.25, z) - F(x - 0.25, z), F(x, z + 0.25) - F(x, z - 0.25)) / 0.5
            room = gap / max(g, 0.05)
            return min(back, 0.75 * room) if back >= 0 else min(-back * room, 3.0)
        # The roof's floor hangs a lip under its stratum's foot: at the foot
        # itself it lay in the plane of the benches of the stratum below, and
        # the two fought for the depth test wherever a bench showed from the
        # road (set pieces draw both sides of a face).
        roofed = bi == rb and tunnel is not None
        parts += strata_band(every[bi], -0.6 if bi == 0 else y0 - (0.12 if roofed else 0.0), y1, setback, col,
                             dark=dark if low else None, floor=roofed, peaks=peaks)
    chunked(parts, 20.0, 25.0, 'rock')
    return tunnel

def chunked(objs, sx, sz, name):
    """Re-cut `objs` by where each face's middle falls on an sx by sz grid
    (glTF x, z), one part per cell holding every object's share of it: a
    piece as wide as a mountain then culls and takes its far form a
    corner at a time (the renderer's tiles go by whole part)."""
    import bmesh
    cells = {}
    for o in objs:
        for poly in o.data.polygons:
            c = poly.center                                        # Blender (x, -z, y)
            cells.setdefault((math.floor(c.x / sx), math.floor(-c.y / sz)), {}).setdefault(o.name, set()).add(poly.index)
    for k, (key, share) in enumerate(sorted(cells.items())):
        made = []
        for oname, keep in share.items():
            src = bpy.data.objects[oname]
            bm = bmesh.new()
            bm.from_mesh(src.data)
            bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context='FACES')
            me = bpy.data.meshes.new(oname + '_%d' % k)
            bm.to_mesh(me)
            bm.free()
            me.materials.append(atlas_material())
            o = bpy.data.objects.new(oname + '_%d' % k, me)
            bpy.context.scene.collection.objects.link(o)
            for prop in src.keys():
                o[prop] = src[prop]
            made.append(o)
        group(made, '%s%d' % (name, k))
    for o in objs:
        bpy.data.objects.remove(o)

def massif_height(forms, rough=1.0, seed=0.0, warp=2.0):
    """M(x, z) for strata_massif: the smooth union of `forms`, each (x, z, h,
    rx, rz, yaw, p, len) a peak (a ridge `len` long along its own z) falling
    from h to nothing at (rx, rz) on a (1 - t)^p flank (concave as a peak's
    is for p over 1, a steep-sided spur under it), the plane bent by a few
    long waves first (`warp` units: no outline a circle or a straight line),
    roughened (none at the foot) and its rim sunk half a unit."""
    def form(x, z, cx, cz, h, rx, rz, yaw, p, ln):
        c, s = math.cos(yaw), math.sin(yaw)
        lx, lz = (x - cx) * c - (z - cz) * s, (x - cx) * s + (z - cz) * c
        t = math.hypot(lx / rx, max(0.0, abs(lz) - ln / 2) / rz)
        return h * max(0.0, 1.0 - t) ** p
    def M(x, z):
        x, z = (x + warp * (math.sin(0.21 * z + 0.7 + seed) + 0.55 * math.sin(0.43 * z + 2.0)),
                z + warp * (math.sin(0.19 * x + 1.9 + seed) + 0.5 * math.sin(0.47 * x + 0.3)))
        m = 0.0
        for f in forms:
            v = form(x, z, *f)
            k = max(0.0, 3.0 - abs(v - m)) / 3.0                  # a smooth max: saddles between peaks
            m = max(m, v) + 0.75 * k * k * min(1.0, min(m, v) / 3.0) if min(m, v) > 0.0 else max(m, v)
        if m > 0.0:
            n = (0.9 * math.sin(0.31 * x + 0.53 * z + 1.3 + seed) * math.cos(0.27 * z - 0.41 * x + 0.4)
                 + 0.5 * math.sin(0.83 * x - 0.2 * z + 2.1 + seed) * math.sin(0.71 * z + 0.9 * x + 0.3))
            m += rough * n * min(1.0, m / 3.0)
        return m - 0.5
    return M

# The canyon's strata (Sidewinder's massif, its foothills, Wash's butte), foot
# to summit: slopes of the softer rock lying back as the mountain does, broken
# by cliffs of the harder (a small setback).
CANYON_STRATA = ((-0.6, 1.3, 0xa96545, -0.85), (1.3, 2.6, 0xd68f62, 0.2), (2.6, 3.9, 0xa96545, -0.85),
                    (3.9, 6.0, 0xd68f62, -0.85), (6.0, 8.0, 0xe3cfa4, 0.25), (8.0, 10.0, 0xa96545, -0.85),
                    (10.0, 12.0, 0xd68f62, 0.2), (12.0, 13.6, 0xa96545, -0.85), (13.6, 15.6, 0xe3cfa4, 0.25),
                    (15.6, 17.4, 0xd68f62, -0.85), (17.4, 19.6, 0xa96545, 0.25), (19.6, 21.2, 0xb4714d, -0.85),
                    (21.2, 23.0, 0x8a4a32, -0.85))

# Sidewinder's tunnel massif (the telegraph line climbs over it: telegraph_line)
TUNNEL_FORMS, TUNNEL_ROUGH = (
    (0.0, 0.5, 11.0, 12.0, 10.0, 0.5 * math.pi, 0.5, 5.0),     # the saddle over the road, steep-faced
    (8.0, -1.0, 14.5, 7.0, 8.5, 0.3, 1.0, 0.0),                # the peak left of the tunnel
    (-8.0, 0.5, 17.0, 8.5, 9.0, -0.4, 1.1, 0.0),               # the peak right of it
    (-20.0, 5.0, 14.0, 10.0, 9.0, -1.19, 1.0, 18.0),           # the ridge running off to the right
    (-19.0, 4.0, 23.0, 11.5, 10.5, 0.9, 1.3, 3.0),             # its summit
    (-30.0, 6.0, 11.0, 7.0, 8.0, 0.0, 1.0, 0.0),               # its end, where the range runs on as land
    (-12.0, -9.0, 10.0, 6.0, 5.0, 0.5, 1.0, 0.0),              # a buttress toward the approach
    (-14.0, 13.0, 11.0, 9.0, 6.0, 0.3, 1.0, 0.0)), 1.4         # the back of the massif

@piece(1.0)
@plain
def mountain_tunnel():
    # Sidewinder: the long straight runs through a mountain. A massif of the
    # canyon's banded rock rises off its right, peaks seventeen units and
    # fourteen over the plain, and throws a spur across the road that falls
    # away into the low ground inside the bend beyond; the road goes through
    # the spur in a tunnel (local z), its walls the lower strata cut a
    # corridor wide (past spotIssue's 3.7 u road margin), its ceiling the
    # first stratum over 3.9 (3.45 over the deck, past OVER_GAP and every
    # chase camera). Ahead of and behind the tunnel the corridor runs on as
    # a cutting through the strata's feet. Rock, so big as rock is, and it
    # stands from the plain: its scree drapes, so it levels no clearing.
    # +X is the road's left.
    M = massif_height(TUNNEL_FORMS, rough=TUNNEL_ROUGH)
    tunnel = strata_massif(M, -40.0, 18.0, -24.0, 26.0, CANYON_STRATA, corridor=(4.5, 3.9), step=3.3, tol=0.5)
    print('MOUNTAIN tunnel z', tunnel, ' M at x=+-4.5:',
          [(z, round(M(-4.5, z), 1), round(M(4.5, z), 1)) for z in range(-12, 13, 3)])
    def scree():
        # blocks fallen from the cutting's walls and the spur, lying on the verge and the plain
        for i, (x, z, s) in enumerate(((5.6, -12.5, 0.9), (-5.8, -11.5, 1.1), (5.9, 10.5, 0.8),
                                       (-6.2, 11.5, 1.0), (14.0, -4.0, 1.2), (-14.0, -14.0, 1.3))):
            box((s * 1.5, s * 0.8, s * 1.2), (x, s * 0.3, z), 0xa96545, yaw=0.8 * i, roll=0.15)
    draped('scree', scree)

@piece(1.0)
@plain
def tunnel_foothills():
    # Sidewinder: the tunnel massif's foothills, in its own strata, curling
    # round the outside of the hairpin past the tunnel (placed on the
    # tunnel's own anchor, so this frame is its: the road runs out along +Z,
    # turns left round the apex at z ~31 and back along -Z at x ~14-24), the
    # inside of the bend left low where the massif's spur falls away. Rock
    # by the road is geometry: steep land is the Android box's dear pixels.
    M = massif_height((
        (-10.0, 31.0, 7.5, 5.5, 6.0, 0.3, 1.0, 6.0),                # off the run-in's right, at the bend
        (2.0, 43.5, 9.0, 7.0, 5.5, -0.2, 1.1, 8.0),                # round the apex
        (17.0, 41.0, 7.0, 6.0, 5.0, 0.5, 1.0, 4.0),
        (30.5, 26.0, 7.5, 5.5, 6.5, 0.1, 1.0, 8.0),                # off the return leg's right
        (31.0, 10.0, 6.0, 5.0, 6.0, 0.0, 1.0, 6.0)), rough=1.0, seed=3.1)
    strata_massif(M, -20.0, 46.0, 14.0, 56.0, [b for b in CANYON_STRATA if b[0] < 9.0],
                  step=2.6, tol=0.4)
    def scree():
        for i, (x, z, s) in enumerate(((-15.0, 38.0, 0.9), (11.0, 50.0, 1.0), (41.0, 18.0, 0.8))):
            box((s * 1.5, s * 0.8, s * 1.2), (x, s * 0.3, z), 0xa96545, yaw=0.8 * i, roll=0.15)
    draped('scree', scree)

@piece(1.0)
@plain
def wash_butte():
    # Wash: a butte in the knot of strands at the map's middle, inside the
    # low hairpin, a table of the canyon's banded strata on its talus (+X
    # the low road): one broad, tall form the low road rounds and the high
    # road passes, geometry, so its cliffs cost the box no rock pixels.
    M = massif_height(((0.0, 0.0, 14.0, 4.6, 5.4, 0.3, 0.5, 2.0),), rough=0.7, seed=6.1)
    strata_massif(M, -10.0, 10.0, -11.0, 11.0, [b for b in CANYON_STRATA if b[0] < 9.0], step=2.2, tol=0.35,
                  summits=False)
    def scree():
        for i, (x, z, s) in enumerate(((-6.5, 3.0, 0.7), (-3.0, -7.0, 0.8))):
            box((s * 1.5, s * 0.8, s * 1.2), (x, s * 0.3, z), 0xa96545, yaw=0.8 * i, roll=0.15)
    draped('scree', scree)

@piece(1.0)
def bench_ledge():
    # Wash: the bench's edge beside the high road (+X the road, Z along it):
    # an outcrop of its banded sandstone one to two car heights, the strata
    # stepping back in ledges, a stand of saguaros and brush behind it, all
    # draped on the bench as drawn (the rock is geometry: steep land rock is
    # the Android box's dear pixels). Never at the kerb.
    lump = massif_height(((0.0, -7.0, 2.4, 3.2, 3.4, 0.0, 0.7, 4.0), (-0.4, 2.0, 2.9, 3.4, 3.6, 0.0, 0.7, 5.0),
                          (0.0, 9.5, 2.2, 3.0, 2.6, 0.0, 0.7, 2.0)), rough=0.7, seed=4.2, warp=0.8)
    def M(x, z):
        # broken off sheer toward the road, every stratum showing in the
        # face, and stepping away behind
        return min(lump(x, z), 3.0 * (1.3 + 0.45 * math.sin(0.55 * z + 1.0) + 0.25 * math.sin(1.7 * z) - x))
    canyon_rock(M, -4.0, 4.0, -14.0, 14.0,
                ((-0.6, 0.6, 0xd68f62, 0.2), (0.6, 1.2, 0xa96545, 0.25), (1.2, 1.75, 0xe3cfa4, 0.2), (1.75, 2.4, 0xd68f62, 0.2)),
                'drape_ledge', grid=0.25, tol=0.15, step=1.5, jitter=0.15, summits=False)
    def stand():
        saguaro((-3.2, 0, -8.0), 4.0, arms=((0.3, 0.42, 0.36), (3.5, 0.52, 0.3)))
        saguaro((-3.0, 0, 0.6), 4.8, arms=((2.2, 0.38, 0.4), (5.3, 0.5, 0.3), (0.9, 0.62, 0.22)), bloom=True)
        saguaro((-3.4, 0, 7.4), 3.6, arms=((4.0, 0.48, 0.32),))
        for z in (-5.5, 3.5, 10.0):
            brush((-2.9, 0, z), 0.8, yaw=z)
        barrel_cactus((-2.7, 0, -2.0), 1.0)
    draped('cacti', stand)

BURRO = dict(coat='bark', mane='dark', muzzle='cream', belly='cream', stripe='dark', ears=0.12)

@piece(1.0)
def tinaja():
    # Wash: a tinaja where the side wash meets the road past the east loop,
    # a hollow in the slickrock holding the rain (+X the road): a shelf of
    # pale sandstone the pool lies in, its strata stepping up in ledges
    # round the back of the water and open to the road, so the pool shows
    # from the kerb; three mustangs (a bay drinking, a dun with its
    # head up, a grey-brown mare) come to water at it. Water and rock only.
    dome = massif_height(((-4.6, 0.0, 2.4, 2.8, 4.6, 0.0, 1.0, 3.0), (-1.0, 0.0, 1.0, 4.8, 5.0, 0.0, 0.5, 1.0)),
                         rough=0.5, seed=2.3, warp=0.6)
    PX, PZ, PR = -1.3, 0.0, 1.9
    def M(x, z):
        d = math.hypot(x - PX, (z - PZ) * 0.9) / PR
        return min(dome(x, z), 0.1 + 1.8 * max(0.0, d * d - 1.0))       # the hollow
    canyon_rock(M, -9.0, 5.0, -8.0, 8.0,
                ((-0.6, 0.2, 0xd68f62, 0.25), (0.2, 0.5, 0xe3cfa4, 0.3), (0.5, 0.85, 0xd68f62, 0.3),
                 (0.85, 1.3, 0xa96545, 0.25), (1.3, 1.9, 0xd68f62, 0.2)),
                'rock', grid=0.25, tol=0.12, step=1.2, jitter=0.12, summits=False)
    rowed(ground_poly([(PX + (1.62 + 0.14 * math.sin(2.3 * k)) * math.cos(2 * math.pi * k / 14), 0.27,
                        PZ + (1.62 + 0.14 * math.sin(2.3 * k)) / 0.9 * math.sin(2 * math.pi * k / 14)) for k in range(14)],
                      [tuple(range(14))], 'sky'), 17)                    # the water
    with plain_parts():                                                  # the shelf under their hooves, in the rock
        for x, z in ((0.8, -0.7), (1.0, 0.9), (0.25, 2.3)):
            box((0.5, 0.3, 0.3), (x, 0.04, z), 0xd68f62)
    equine((0.8, 0.2, -0.7), math.pi * 0.95, 'brown', L=0.52, mane='dark', legs='dark', head=0.85,
           life='anim_sway:a=z:d=22:p=6.7:r=0.7#d')                             # a bay, drinking
    equine((1.0, 0.2, 0.9), math.pi * 1.1, 'tan', L=0.5, mane='dark', legs='dark', stance=1,
           life='anim_sway:a=z:d=10:p=8.3:r=0.8#l')                             # a dun, watching the road
    equine((0.25, 0.2, 2.3), math.pi * 1.35, 'bark', L=0.47, mane='dark', muzzle='cream', head=0.4, stance=-1)
    join_still('tinaja')

# Crag's rock: the canyon's level strata (strata_massif) over a butte's
# height, its tables left flat (no summit drawn up to a point): rock standing
# in the talus it sheds, every stratum on an outline of its own, so the cliff
# weathers in and out as it climbs instead of standing as a drum.
def butte_height(tiers, talus, reach, seed, jag):
    """M(x, z) for strata_massif: each of `tiers` (x, z, top, rx, rz, yaw,
    len, taper) a table `top` high on a capsule `len` along its own z, its
    cliff falling from its rim (rx, rz) and leaning back `taper` of that as
    it climbs. The rim is cut into alcoves and buttresses by a few waves
    round it, its long sides into gullies and the buttresses between them
    about every 4.5 u (a long side left straight stood as one flat wall), and
    it is roughened by `jag` of it over the plane (so each stratum's outline
    is its own, not the one below grown or shrunk); under them the talus,
    `talus` high at the rims, falling concave to nothing `reach` past them.
    The plane is bent by long waves first, so no outline is an oval."""
    def rim(a, k):
        return 1.0 + (0.07 * math.sin(3 * a + 1.3 * k + seed) + 0.05 * math.sin(5 * a + 2.1 * k + 1.7 * seed)
                      + 0.04 * math.sin(9 * a + 0.7 * k + 2.9 * seed) + 0.025 * math.sin(14 * a + k + 0.3 * seed))
    def gullies(k, lz, side, span):
        n = max(2, int(span / 4.5))
        v = 0.0
        for i in range(n):
            z0 = -span / 2 + span * (i + 0.5 + 0.3 * hash1(i, k, seed + side)) / n
            w = 0.9 + 0.4 * abs(hash1(i, k, seed + 2.3 * side))
            v += 0.22 * hash1(i, 3.0 * k + side, seed + 1.7) * math.exp(-((lz - z0) / w) ** 2)
        return v
    def M(x, z):
        x, z = (x + 1.6 * (math.sin(0.23 * z + 0.4 + seed) + 0.5 * math.sin(0.51 * z + 2.2)),
                z + 1.6 * (math.sin(0.21 * x + 1.1 + seed) + 0.5 * math.sin(0.47 * x + 0.8)))
        n = jag * (math.sin(0.93 * x + 0.61 * z + 1.3 + seed) * math.cos(0.77 * z - 0.52 * x + 0.4)
                   + 0.6 * math.sin(1.71 * x - 0.4 * z + 2.1 + seed) * math.sin(1.53 * z + 0.9 * x + 0.3))
        m, past = 0.0, 1e9
        for k, (cx, cz, top, rx, rz, yaw, ln, taper) in enumerate(tiers):
            c, s = math.cos(yaw), math.sin(yaw)
            lx, lz = (x - cx) * c - (z - cz) * s, (x - cx) * s + (z - cz) * c
            ez = math.copysign(max(0.0, abs(lz) - ln / 2), lz)
            west = max(0.0, min(1.0, 0.5 + lx / rx))                   # which side's gullies, blended over the tip
            cut = west * gullies(k, lz, 1, ln + 2 * rz) + (1 - west) * gullies(k, lz, -1, ln + 2 * rz)
            shape = math.hypot(lx / rx, ez / rz) / rim(math.atan2(ez / rz, lx / rx), k)
            t = shape * (1.0 + cut) + n
            # the talus off the smooth outline: off the rough one, its contours
            # broke into islands that strata_massif's slope inset folded
            # inside out, a dark shard on a hump
            past = min(past, (shape - 1.0) * math.sqrt(rx * rz))
            v = top * min(1.0, max(0.0, (1.0 - t) / taper)) ** 0.8
            q = max(0.0, 3.0 - abs(v - m)) / 3.0                      # a smooth max: a fillet where tiers meet
            m = max(m, v) + 0.6 * q * q * min(1.0, min(m, v) / 3.0) if min(m, v) > 0.0 else max(m, v)
        fall = talus * max(0.0, 1.0 - max(0.0, past) / reach) ** 1.6
        return max(m, fall) - 0.5
    return M

# Crag's strata, foot up: the talus one colour, near the sand's, lying back as
# the slope does (banded, its stripes read as the walls the user rejected);
# then the one hard sandstone standing as a cliff, each bed stepping back
# most of the way to the next (a full ledge on every bed left a pale sliver,
# sparkling down the face; a slope's lean, which strata_massif lets reach 3 u,
# folded a small tower's rings inside out), with a pale bed or two across a
# broad table's cliff (a tower
# stays one colour: striped bed by bed it read as a stack of drums), and the
# caprock on the highest tier.
CRAG_TALUS, CRAG_CLIFF, CRAG_PALE = 0xd68f62, 0xa96545, 0xd68f62

def crag_butte(tiers, talus, reach, extent, seed, pale=0, jag=0.07):
    """A butte of Crag's strata over butte_height, on [-extent, extent]^2,
    with `pale` light beds across its cliff."""
    M = butte_height(tiers, talus, reach, seed, jag)
    top = max(t[2] for t in tiers)
    k = talus / 5.0
    c0 = 6.4 * k
    bands = [(-0.6, 1.6 * k, CRAG_TALUS, -0.9), (1.6 * k, 3.4 * k, CRAG_TALUS, -0.9),
             (3.4 * k, 5.0 * k, CRAG_TALUS, -0.8), (5.0 * k, c0, CRAG_TALUS, -0.6)]
    cap = min(1.0, 0.12 * top)
    c1 = top - cap
    light = [c0 + (c1 - c0) * (i + 1) / (pale + 1) for i in range(pale)]
    cuts = sorted(set([c0, c1] + [y for l in light for y in (l - 0.6, l + 0.6)]))
    for y0, y1 in zip(cuts, cuts[1:]):
        dark = not any(l - 0.6 <= y0 < l + 0.6 for l in light)
        n = max(1, round((y1 - y0) / 3.0))
        for i in range(n):
            bands.append((y0 + (y1 - y0) * i / n, y0 + (y1 - y0) * (i + 1) / n, CRAG_CLIFF if dark else CRAG_PALE, 1.0))
    bands.append((c1, top, CRAG_CLIFF, 0.08))
    strata_massif(M, -extent, extent, -extent, extent, bands, step=2.2, tol=0.3, jitter=0.35, summits=False)
    # stones fallen off the cliff lying on the talus, in its colour (dark
    # ones read as holes), each dropped onto the strata as built
    import random
    ground = built_ground()
    rnd = random.Random(seed)
    with plain_parts():
        n = 0
        for _ in range(4000):
            if n >= int(extent * 0.8):
                break
            x, z = rnd.uniform(-extent, extent), rnd.uniform(-extent, extent)
            if not 0.6 < M(x, z) < c0 - 0.6:
                continue
            q = rnd.uniform(0.35, 0.8)
            ys = [ground(x + dx, z + dz) for dx in (-0.6 * q, 0.6 * q) for dz in (-0.5 * q, 0.5 * q)]
            if None in ys or max(ys) - min(ys) > 0.5 * q:
                continue                                        # astride a step: it would hang
            box((q * 1.5, q * 0.7, q * 1.1), (x, min(ys) + 0.15 * q, z), CRAG_TALUS, yaw=rnd.uniform(0, 3.1),
                roll=rnd.uniform(-0.15, 0.15), pitch=rnd.uniform(-0.1, 0.1))
            n += 1

def built_ground():
    """The height of the meshes built so far at (x, z) (None off them): what
    a block is dropped onto, the strata as built, a band's slope lying a
    little under its height function."""
    from mathutils.bvhtree import BVHTree
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    trees = [BVHTree.FromObject(o, deps) for o in bpy.context.scene.objects if o.type == 'MESH']
    def ground(x, z):
        hits = [t.ray_cast(P(x, 60.0, z), Vector((0.0, 0.0, -1.0))) for t in trees]
        return max((h[0].z for h in hits if h[0] is not None), default=None)
    return ground

def crag_rubble(spots):
    """Low stones past the talus, lying on the plain in its colour: they
    drape, so the piece stands from the plain and levels no clearing."""
    def rubble():
        for i, (x, z, s) in enumerate(spots):
            box((s * 1.5, s * 0.5, s * 1.2), (x, s * 0.15, z), CRAG_TALUS, yaw=0.8 * i)
    draped('rubble', rubble)

@piece(1.0)
@plain
def rimrock_mesa():
    # Crag: the mesa between the north-east loop and the S: a table of the
    # strata thirteen units to its caprock behind a bench seven high on its
    # west side (+X, where the loop runs along it), a higher table set back
    # east of it, and south, past a gap of sky, a butte that broke away and a
    # fin beyond that, all standing in the talus they shed, so the loop
    # rounds the table and the S passes the butte's west side. Low enough
    # that its caprock stays in a racer's picture as the road runs at it,
    # never one long face: a single table half again as long, a sheer side
    # broadside to the bridge, read as a wall, and one sheer face by the loop
    # as a band across the top of a 4P cell.
    crag_butte(((0.5, 13.0, 7.0, 9.0, 9.5, 0.25, 10.0, 0.25), (-5.0, 13.0, 13.0, 6.5, 7.5, 0.25, 8.0, 0.2),
                (-7.0, 15.0, 16.0, 3.5, 4.0, 0.4, 2.0, 0.2),
                (12.5, -24.0, 14.0, 6.0, 6.5, -0.3, 3.0, 0.22), (1.0, -39.0, 11.0, 2.8, 2.4, 0.0, 1.5, 0.45)),
               4.0, 8.0, 46.0, 2.7, pale=1)
    # (no blocks on the apron: its stepped slope buries all but their shaded
    # faces, which read as holes torn in the sand)
    crag_rubble(((-16.0, -32.0, 0.8), (-22.0, 26.0, 0.9)))           # on the east side, off both roads
    # a hawk riding the air off the north end, where the loop rounds it
    hawk_circle((2.0, 27.0), 9.0, 6.0, 17.0)

@piece(1.0)
@plain
def rimrock_butte():
    # Crag: a butte of the land's own rock, a table fifteen units to its
    # caprock set back behind a bench of its strata on the road's side (+X),
    # and off its south end, past a gap of sky, a smaller butte that broke
    # away, both standing in the talus they shed. Rock, so big as rock is:
    # a hill's size, but no taller than a racer's picture holds as the
    # bridge runs at it (at twenty-two its cap left the frame).
    crag_butte(((-2.0, 4.0, 15.0, 8.0, 9.0, 0.15, 8.0, 0.2), (2.0, 0.0, 8.0, 12.0, 12.5, -0.1, 10.0, 0.25),
                (3.0, -26.0, 12.0, 5.0, 5.0, 0.2, 2.0, 0.25)), 4.0, 8.0, 42.0, 0.4, pale=1)
    crag_rubble(((-31.0, 2.5, 0.8), (-12.0, 30.0, 0.8)))              # behind it, never by a kerb

@piece(1.0)
@plain
def rimrock_spires():
    # ...and two of its towers standing out of one pedestal of their strata,
    # the taller twenty-four units high, the other seventeen: a butte the
    # weather has nearly finished, so no two of the track's rocks read as
    # one model.
    crag_butte(((-2.5, -3.0, 24.0, 5.6, 3.4, 0.3, 2.5, 0.45), (6.0, 4.5, 17.0, 4.6, 3.0, -0.6, 2.0, 0.4),
                (1.5, 0.5, 6.0, 9.5, 7.0, 0.6, 6.0, 0.3)), 3.5, 7.0, 26.0, 1.9, jag=0.12)
    crag_rubble(((2.0, -21.0, 0.8), (-3.0, 20.0, 0.8)))               # out at the ends, never by a kerb

@piece(1.0)
@plain
def rimrock_mitten():
    # ...and the south loop's: a fin of the rock twenty-one units high with
    # a thumb standing off it, eighteen, on one pedestal: the other pair of
    # spires has two towers of a height, so the two loops' rocks never read
    # as one model.
    crag_butte(((-3.0, 0.0, 21.0, 5.5, 4.0, 0.2, 5.0, 0.35), (5.5, 3.0, 18.0, 2.8, 2.6, 0.0, 0.0, 0.5),
                (0.5, 1.0, 5.5, 10.0, 7.5, 0.3, 6.0, 0.3)), 3.5, 7.0, 26.0, 3.3, jag=0.12)
    crag_rubble(((1.0, -21.0, 0.8), (-2.0, 21.0, 0.8)))

def emblem(at, yaw, r, d=0.04):
    """The oil company's mark, facing +X turned by `yaw`: a white disc in a
    red rim, a red drop of oil on it. `at` is the back of the rim, `d` its
    depth (deeper where it sits on a curved wall, so its edge meets it)."""
    fx, fz = math.cos(yaw), -math.sin(yaw)
    def out(k):
        return (at[0] + k * fx, at[1], at[2] + k * fz)
    cyl(r * 1.15, d, at, 'red', segs=16, axis='across', yaw=yaw)
    cyl(r, 0.04, out(d - 0.01), 'white', segs=16, axis='across', yaw=yaw)
    # the drop: a round belly under a point, a board cut to shape
    a, c = 0.42 * r, -0.18 * r
    rim = [(-a * math.cos(math.radians(f)), c + a * math.sin(math.radians(f))) for f in range(130, 411, 35)]
    o = prism([(0.0, 0.62 * r)] + rim, 0.0, 0.03, 'red')
    o.location = P(*out(d + 0.05))
    o.rotation_euler = (0.0, 0.0, yaw)

STATION_WIRE = (15.45, -3.6)   # the telegraph line's corner pole, in the filling station's frame

@piece(1.0)
def filling_station():
    # Sidewinder: the oil field's own filling station by the start line, at
    # its own size beside a car: the shop with its door to the road (+X), a
    # canopy over two pumps in front of it, a stack of tyres and oil drums,
    # and the tall sign by the road turning on its pole (anim_spin), the
    # company's mark on both its faces. A hawk circles over it.
    hut(2.6, 1.2, 2.0, (-2.2, 0, 0), 0xf2efe6, 0xc0392b)
    box((0.1, 0.3, 1.6), (-0.85, 1.05, 0), 0xc0392b)                             # its name board
    for sx in (0.2, 2.6):
        for sz in (-1.1, 1.1):
            box((0.14, 1.4, 0.14), (sx, 0.7, sz), 'white')
    box((3.0, 0.2, 2.8), (1.4, 1.5, 0), 'white')                                 # the canopy
    box((3.06, 0.12, 2.86), (1.4, 1.36, 0), 0xc0392b)
    with plain_parts():
        for z in (-0.5, 0.5):                                                        # the pumps on their island
            box((0.3, 0.6, 0.26), (1.4, 0.38, z), 0xc0392b)
            box((0.32, 0.12, 0.28), (1.4, 0.72, z), 'white')
            box((0.06, 0.06, 0.06), (1.58, 0.5, z), 'dark')
        box((0.6, 0.08, 1.6), (1.4, 0.04, 0), 'grey')
        for k, (x, z) in enumerate(((-0.6, 1.4), (-0.3, 1.6), (-0.9, 1.7))):          # oil drums
            cyl(0.13, 0.34, (x, 0, z), 0x3f6fd1 if k % 2 else 0xc0392b, segs=8)
        for i in range(3):                                                           # a stack of tyres
            cyl(0.2, 0.1, (-0.7, i * 0.1, -1.5), ROPE, segs=8)
        box((0.14, 3.0, 0.14), (2.6, 1.5, -2.6), 'slate')                            # the sign's pole
        with animated('anim_spin:a=y:w=0.9#s', (2.6, 3.3, -2.6)):
            box((0.12, 0.6, 1.2), (2.6, 3.3, -2.6), 0xc0392b)
            emblem((2.66, 3.3, -2.6), 0.0, 0.24)
            emblem((2.54, 3.3, -2.6), math.pi, 0.24)
    # the telegraph line's end: it comes over the road from its corner pole
    # on the far verge (telegraph_line; STATION_WIRE is that pole in this
    # frame) to a tall pole by the sign, high over the cars, and drops to
    # the shop's eaves
    with plain_parts():
        bx, bz = 4.9, STATION_WIRE[1]
        telegraph_pole((bx, 0, bz), TEL_TALL, yaw=math.pi / 2)
        telegraph_span((bx, bz), STATION_WIRE, TEL_TALL - 0.05, TEL_TALL - 0.05, yaw_a=math.pi / 2, yaw_b=math.pi / 2)
        tube(sag((bx, TEL_TALL - 0.25, bz), (-1.2, 1.5, -1.05), 0.25, n=5), 0.025, ROPE, res=2, bevel_res=0, wire=True)
    hawk_circle((0.4, -0.6), 4.6, 3.6, 14.0)
    join_still('station')

def pickup(x, z, color, yaw=0.0):
    """A pickup truck, a racer and a half long (its cab to +Z), standing in
    a colour no racer wears: round wheels with their hubs under arches, a
    bonnet lower than the cab, its glass, lamps and bumpers, the bed open
    behind."""
    c, s = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x + dx * c + dz * s, dy, z - dx * s + dz * c)
    def part(dx, dy, dz, size, col):
        box(size, at(dx, dy, dz), col, yaw=yaw)
    for sx in (-1, 1):
        for sz in (-0.46, 0.44):
            cyl(0.16, 0.11, at(sx * 0.33 - (0.11 if sx > 0 else 0), 0.16, sz), 0x2a2735, segs=12, axis='across', yaw=yaw)
            cyl(0.07, 0.02, at(sx * 0.34 - (0.02 if sx > 0 else 0), 0.16, sz), 0x868ba1, segs=8, axis='across', yaw=yaw)
    part(0, 0.34, 0.0, (0.6, 0.2, 1.44), color)                      # the body
    part(0, 0.49, 0.5, (0.56, 0.12, 0.42), color)                    # the bonnet
    part(0, 0.6, 0.1, (0.56, 0.34, 0.4), color)                      # the cab
    part(0, 0.66, 0.305, (0.5, 0.18, 0.02), 0x8ecae6)                # its windscreen
    for sx in (-1, 1):
        part(sx * 0.285, 0.66, 0.1, (0.02, 0.16, 0.28), 0x8ecae6)    # the side glass
        part(sx * 0.2, 0.45, 0.725, (0.12, 0.08, 0.02), 0xfde4c7)    # the lamps
        part(sx * 0.28, 0.52, -0.4, (0.05, 0.16, 0.62), color)       # the bed's sides
    part(0, 0.52, -0.71, (0.6, 0.16, 0.05), color)                   # the tailgate
    part(0, 0.27, 0.75, (0.64, 0.07, 0.06), 0x868ba1)                # the bumpers
    part(0, 0.27, -0.75, (0.64, 0.07, 0.06), 0x868ba1)

@piece(1.0)
@plain
def tank_farm():
    # Sidewinder: the field's tank farm outside the north loop's first
    # corner, where the whole east straight points: three broad crude tanks
    # at a real farm's size (the big one some twenty metres across) in a
    # triangle, so the straight sees all three side by side: the big one in
    # front, its stair winding up its side and the company's mark turned to
    # the straight (bearing YAW); the middle one white behind its right, the
    # small rust one off its left. Each wears the company's band under a dark
    # roof rim, the white ones the seams of their courses, and the two
    # smaller ones a ladder up their road side. A low manifold on short
    # supports joins them to a pump house between, all on a flush dirt pad
    # (+X is the road, wrapping round the corner).
    YAW = math.radians(44.6)
    ground_poly([(-3.6, 0.03, -6.6), (7.6, 0.03, -6.6), (8.2, 0.03, 5.8), (2.0, 0.03, 6.4), (-3.8, 0.03, 0.8)],
                [(0, 1, 2, 3, 4)], 0xb8a686)
    B, M, S = (4.4, -2.8, 2.3, 3.6), (5.0, 3.2, 1.8, 3.0), (-1.2, -3.6, 1.3, 2.2)
    def ladder(x, z, r, h):
        # up the tank's road side (+X): two rails and their rungs
        for t in (-0.13, 0.13):
            strut((x + r + 0.1, 0.0, z + t), (x + r + 0.1, h + 0.25, z + t), 0.05, 'slate')
        for k in range(1, int(h / 0.3) + 1):
            box((0.04, 0.04, 0.26), (x + r + 0.1, 0.3 * k, z), 'slate')
    for (x, z, r, h), col in ((B, 'white'), (M, 'white'), (S, 0xc0392b)):
        cyl(r, h, (x, 0, z), col, segs=16)
        cyl(r + 0.04, 0.3, (x, h, z), 'white' if col == 'white' else 'grey', r2=0.35 * r, segs=16)   # its roof
        cyl(r + 0.06, 0.1, (x, h - 0.04, z), 'slate', segs=16)                  # the roof's rim
        cyl(r + 0.03, 0.3, (x, h - 0.32, z), 'red' if col == 'white' else 'white', segs=16)   # the band
        if col == 'white':
            for y in (h / 3, 2 * h / 3):
                cyl(r + 0.02, 0.05, (x, y, z), 'grey', segs=16)                 # its courses' seams
    x, z, r, h = B
    emblem((x + (r - 0.16) * math.cos(YAW), 2.0, z - (r - 0.16) * math.sin(YAW)), YAW, 0.75, d=0.24)
    n = int((h - 0.3) / 0.27) + 1
    for k in range(n):                                                           # the stair, winding up
        a = math.radians(-58 + 6.5 * k)
        y = 0.12 + 0.27 * k
        rr = r + 0.1
        box((0.22, 0.06, 0.42), (x + rr * math.cos(a), y, z - rr * math.sin(a)), 'slate', yaw=a)
    rr = r + 0.18
    posts = (n - 1) // 3 + 1
    for k in range(posts):                                                       # and its rail on posts
        a0, a1 = math.radians(-58 + 6.5 * 3 * k), math.radians(-58 + 6.5 * 3 * (k + 1))
        strut((x + rr * math.cos(a0), 0.15 + 0.81 * k, z - rr * math.sin(a0)),
              (x + rr * math.cos(a0), 0.6 + 0.81 * k, z - rr * math.sin(a0)), 0.06, 'slate')
        if k < posts - 1:
            strut((x + rr * math.cos(a0), 0.6 + 0.81 * k, z - rr * math.sin(a0)),
                  (x + rr * math.cos(a1), 0.6 + 0.81 * (k + 1), z - rr * math.sin(a1)), 0.06, 'slate')
    ladder(*M)
    ladder(*S)
    # the pump house between them and the manifold, on supports a knee high
    PX, PZ = 0.8, 0.6
    hut(1.2, 0.9, 1.0, (PX, 0, PZ), 'white', 'red', t=0.4)
    for (x, z, r, h) in (B, M, S):
        d = math.hypot(PX - x, PZ - z)
        ux, uz = (PX - x) / d, (PZ - z) / d
        a, b = (x + ux * r, 0.4, z + uz * r), (PX - ux * 0.62, 0.4, PZ - uz * 0.55)
        strut(a, b, 0.14, 'slate')
        mx, mz = (a[0] + b[0]) / 2, (a[2] + b[2]) / 2
        box((0.1, 0.34, 0.1), (mx, 0.17, mz), 'grey')
        cyl(0.12, 0.08, (mx + ux * 0.4, 0.52, mz + uz * 0.4), 'red', segs=8)    # a valve wheel
    join_still('tanks')

# Which way a positive anim_sway (or spin) about a node's z turns it, seen with
# its +X to the right: 1 lifts +X. The pumpjack's linkage is solved in it.
SWAY_SENSE = 1.0

def pumpjack(x0, z0, yaw, tag, period, paint=('slate', 'yellow', 'red'), flow=1):
    """An oil pumpjack, the nodding donkey, its beam along its local X turned
    by `yaw`, as one stands on a lease: a concrete base under a steel skid;
    the samson post, an A-frame with a ladder up it, carrying the walking
    beam on its saddle bearing; the horsehead on the beam's end, its face an
    arc about the bearing, the bridle hanging from it to the polished rod in
    the wellhead's stuffing box, a flow tee and its valve on the wellhead;
    behind, the gear reducer on its pedestal, a crank either side turning
    with its counterweight, and a pitman arm either side from the beam's
    tail bearing down to the crank's pin; the motor on the skid's end, its
    belt to the reducer's sheave under a guard.

    It is ONE linkage on one clock (every moving part in step, `o`): the
    cranks turn once a `period` (anim_spin), the beam nods with them
    (anim_sway about the saddle), and each pitman rides the beam's tail
    (a part ON the beam) swinging about its bearing there (anim_sway) by
    what keeps its foot on the crank pin: PITMAN fits that swing. The
    crank's throw is the tail's own rise and fall, so the foot stays on the
    pin through the whole turn (within the pin boss's width). Two units
    tall, a real one's height and a half. `paint` is its frame, its
    horsehead and its counterweights; `flow` the side (its local Z) the
    flowline leaves the wellhead on."""
    frame, head, weights = paint
    c, s = math.cos(yaw), math.sin(yaw)
    def at(dx, dy, dz):
        return (x0 + dx * c + dz * s, dy, z0 - dx * s + dz * c)
    def part(size, dx, dy, dz, color, pitch=0.0, roll=0.0):
        box(size, at(dx, dy, dz), color, yaw=yaw, pitch=pitch, roll=roll)
    PY, NOD = 1.6, 16.0                                                         # the saddle's height, the nod
    TAIL, PIT = 1.22, 0.8                                                      # the tail bearing aft of the saddle, the pitman
    THROW = TAIL * math.sin(math.radians(NOD))                                  # the crank's
    CX, CY = -TAIL, PY - PIT                                                    # the crank shaft, under the tail at rest
    ZP = 0.34                                                                   # the pitmans and cranks, either side
    # the pitman's swing on the beam: its foot on the pin at every angle of the turn
    sa = sb = 0.0
    N = 72
    for i in range(N):
        th = 2 * math.pi * i / N
        beta = SWAY_SENSE * math.radians(NOD) * math.sin(th)                    # the beam's turn about +z
        tx, ty = -TAIL * math.cos(beta), PY - TAIL * math.sin(beta)
        psi = SWAY_SENSE * (th + math.pi)                                       # the crank's
        px, py = CX + THROW * math.cos(psi), CY + THROW * math.sin(psi)
        alpha = math.atan2(px - tx, ty - py)                                    # the pitman's turn from plumb, about +z
        f = SWAY_SENSE * (alpha - beta)                                         # ... on the beam, in the sway's own sense
        sa += f * math.sin(th) * 2 / N
        sb += f * math.cos(th) * 2 / N
    swing, lead = math.degrees(math.hypot(sa, sb)), math.atan2(sb, sa) / (2 * math.pi)
    part((3.8, 0.1, 1.1), -0.5, 0.05, 0, 0xb8a686)                             # the concrete base
    for sz in (-1, 1):
        part((3.5, 0.1, 0.1), -0.5, 0.15, sz * 0.2, 'slate')                   # the skid's rails
    for sx in (-1, 1):                                                          # the samson post
        for sz in (-1, 1):
            strut(at(sx * 0.42, 0.18, sz * 0.2), at(0, PY - 0.1, sz * 0.1), 0.1, frame)
    part((0.1, 0.08, 0.36), 0.2, 0.8, 0, frame)
    for i in range(4):                                                          # its ladder
        part((0.03, 0.03, 0.2), 0.34 - 0.085 * i, 0.4 + 0.3 * i, 0.0, frame)
    part((0.22, 0.14, 0.3), 0, PY - 0.08, 0, 'grey')                            # the saddle bearing
    part((0.5, CY - 0.2, 0.4), CX, (CY - 0.2) / 2 + 0.2, 0, 'slate')            # the reducer's pedestal
    part((0.5, 0.42, 0.44), CX, CY, 0, frame)                                   # the gear reducer
    part((0.12, 0.12, 2 * ZP + 0.1), CX, CY, 0, 'grey')                         # its crank shaft
    with animated('anim_spin:a=z:w=%.4f+sway:a=z:d=0:p=%.1f:o=0.5#c%s' % (2 * math.pi / period, period, tag),
                  at(CX, CY, 0), yaw):
        for sz in (-1, 1):                                                      # the cranks, their weights, their pins
            part((THROW + 0.5, 0.14, 0.07), CX + (THROW + 0.26) / 2 - 0.12, CY, sz * (ZP - 0.07), frame)
            part((0.3, 0.36, 0.09), CX + THROW + 0.2, CY, sz * (ZP - 0.07), weights)
            part((0.13, 0.13, 0.12), CX + THROW, CY, sz * ZP, 'grey')
    part((0.4, 0.3, 0.34), -2.0, 0.35, 0, 'grey')                               # the motor
    part((0.7, 0.34, 0.06), -1.66, 0.48, -0.25, 'yellow')                       # its belt guard, to the reducer's sheave
    WX = 1.4                                                                    # the wellhead, under the horsehead's arc
    cyl(0.14, 0.42, at(WX, 0.1, 0), 'slate', segs=8)
    part((0.3, 0.1, 0.3), WX, 0.56, 0, 'grey')                                  # the flow tee
    part((0.1, 0.1, 0.7), WX, 0.5, flow * 0.42, 'slate')
    part((0.18, 0.18, 0.12), WX, 0.5, flow * 0.52, 'red')                       # its valve
    part((0.1, 0.5, 0.1), WX, 0.26, flow * 0.78, 'slate')                       # the flowline, down
    cyl(0.1, 0.12, at(WX, 0.61, 0), 'yellow', segs=8)                           # the stuffing box
    with animated('anim_sway:a=z:d=%.0f:p=%.1f:o=0#%s' % (NOD, period, tag), at(0, PY, 0), yaw):
        part((TAIL + 1.26, 0.2, 0.14), (1.26 - TAIL) / 2, PY + 0.03, 0, frame)  # the walking beam
        part((TAIL + 1.26, 0.04, 0.2), (1.26 - TAIL) / 2, PY + 0.14, 0, frame)  # its flange
        R, HW = 1.42, 0.11                                                      # the horsehead, an arc about the bearing
        arc = [(R * math.cos(math.radians(f)), PY + R * math.sin(math.radians(f))) for f in (16, 6, -6, -18, -28)]
        prof = [(1.06, PY + 0.34)] + arc + [(1.02, PY - 0.62)]
        verts = [at(px, py, -HW) for px, py in prof] + [at(px, py, HW) for px, py in prof]
        n = len(prof)
        solid(verts, [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
              + [(i, n + i, n + (i + 1) % n, (i + 1) % n) for i in range(n)], head)
        # the bridle: it hangs PLUMB off the horsehead's arc over the well (a
        # part on the beam, swinging against the nod), its carrier bar and
        # the polished rod under it running down into the stuffing box
        with animated('anim_sway:a=z:d=%.0f:p=%.1f:o=0.5#b%s' % (NOD, period, tag), at(WX, PY, 0), yaw):
            for sz in (-1, 1):
                part((0.03, 0.5, 0.03), WX, PY - 0.25, sz * 0.07, 'dark')
            part((0.06, 0.05, 0.22), WX, PY - 0.5, 0, 'grey')
            part((0.04, 0.9, 0.04), WX, PY - 0.95, 0, 'white')
        part((0.14, 0.14, 2 * ZP + 0.12), -TAIL, PY, 0, 'grey')                 # the tail bearing's cross shaft
        for sz in (-1, 1):                                                      # the pitman arms, each ON the beam
            with animated('anim_sway:a=z:d=%.2f:p=%.1f:o=%.4f#p%s%d' % (swing, period, lead % 1.0, tag, sz + 1),
                          at(-TAIL, PY, sz * ZP), yaw):
                part((0.07, PIT + 0.08, 0.06), -TAIL, PY - PIT / 2, sz * ZP, 'dark')

@piece(1.0)
def oil_field():
    # Sidewinder: the oil field's pumping wells outside the north loop's
    # second corner, every piece at its own size beside a car (the lap's one
    # derrick is the drilling rig at the S): three pumpjacks on their dirt
    # pads, out of step, nodding (anim_sway), their cranks turning; each
    # one's flowline runs over the ground on low sleepers to the tank
    # battery behind them: two lease tanks, white and red, a real one's size
    # (some seven metres across and as tall), a stair and a catwalk over
    # them, the separator before them on its saddles; and tumbleweeds blow
    # along the field's road side (+X), bouncing as they roll, out of a rock
    # pile at one end and into one at the other (anim_path+spin+bob, home
    # under the ground). The jacks stand broadside to the road (beams along
    # Z), the way a nod reads.
    PADS = ((-1.0, -6.5, 4.6), (-3.4, 0.4, 5.3), (-0.6, 6.8, 4.1))
    TKX, TKZ = -6.8, 4.2                                                        # the battery's middle
    for n, (x, z, per) in enumerate(PADS):
        ground_poly([(x - 1.5, 0.03, z - 2.4), (x + 1.5, 0.03, z - 2.4), (x + 1.5, 0.03, z + 2.4),
                     (x - 1.5, 0.03, z + 2.4)], [(0, 1, 2, 3)], 0xb8a686)
        d = 1 if n % 2 else -1
        pumpjack(x, z, math.pi / 2 * d, 'j%d' % n, per, flow=-d)
        with plain_parts():                                                     # its flowline to the battery
            wz = z - d * 1.4                                                   # the wellhead (the jack's +X is -Z turned d)
            a, b = (x - 0.78, 0.12, wz), (TKX + 1.5, 0.12, TKZ - 0.9 + 0.4 * n)
            for p, q in ((a, (b[0], 0.12, a[2])), ((b[0], 0.12, a[2]), b)):
                strut(p, q, 0.08, 'slate')
            for t in (0.3, 0.7):
                box((0.2, 0.08, 0.2), (a[0] + (b[0] - a[0]) * t, 0.04, wz), 0x8a5f3e)
    with plain_parts():
        ground_poly([(TKX - 1.6, 0.03, TKZ - 3.0), (TKX + 2.2, 0.03, TKZ - 3.0), (TKX + 2.2, 0.03, TKZ + 3.0),
                     (TKX - 1.6, 0.03, TKZ + 3.0)], [(0, 1, 2, 3)], 0xb8a686)
        for k, z in enumerate((TKZ - 1.3, TKZ + 1.3)):                          # the lease tanks
            cyl(1.0, 1.5, (TKX, 0, z), 'white' if k else 'red', segs=14)
            cyl(1.04, 0.1, (TKX, 1.5, z), 'slate', segs=14)
            cyl(1.02, 0.18, (TKX, 1.1, z), 'red' if k else 'white', segs=14)
        box((0.5, 0.05, 3.2), (TKX + 0.9, 1.62, TKZ), 'grey')                   # the catwalk over them
        for z in (TKZ - 1.55, TKZ, TKZ + 1.55):
            box((0.04, 0.3, 0.04), (TKX + 1.13, 1.78, z), 'slate')
        box((0.04, 0.04, 3.2), (TKX + 1.13, 1.93, TKZ), 'slate')
        strut((TKX + 1.2, 0.0, TKZ + 2.9), (TKX + 1.2, 1.62, TKZ + 1.6), 0.3, 'grey')     # its stair
        cyl(0.3, 1.5, (TKX + 1.7, 0.42, TKZ - 2.1), 'grey', segs=10, axis='along', stem=True)   # the separator
        for z in (TKZ - 1.9, TKZ - 0.8):
            box((0.5, 0.3, 0.14), (TKX + 1.7, 0.15, z), 'slate')
        strut((TKX + 1.7, 0.85, TKZ - 1.35), (TKX + 0.8, 1.2, TKZ - 1.3), 0.07, 'slate')
    # the weeds' run along the road side
    L, R, X = 26.0, 0.25, 2.2
    for sz in (-1, 1):
        sandstone_rock((X + 0.3, 0, sz * (L / 2 + 0.6)), 1.0, yaw=0.5 + sz)
    zs = [-L / 2 + L * i / 12 for i in range(13)]
    for k, pt in enumerate([(X, R, z) for z in zs] + [(X, -1.6, L / 2), (X, -1.6, -L / 2)]):
        marker('path_weeds_%d' % k, pt)
    for n in range(3):
        z = zs[1 + 4 * n]
        with animated('anim_path:c=weeds:p=30:o=%.3f:f=1+spin:a=z:w=-7.5+bob:h=0.28:p=%.2f:r=0.35#%d'
                      % (n / 3, 0.72 + 0.07 * n, n), (X, R, z)):
            tumbleweed((X, R, z), R)
    join_still('field')

@piece(1.0)
def drilling_rig():
    # Sidewinder: the field's drilling rig on the S's left, where the camera
    # points three times a lap, a working rotary rig at its own size beside
    # a car (its crown some thirty metres up), on a flush dirt pad (+X is the
    # S's side, -Z the way it runs): the drill floor a unit up on its
    # substructure over the red blowout preventer; the white steel mast
    # tapering over it to the red crown block, its top two girts red, the
    # company's flag flying from the crown (anim_sway); the travelling block
    # riding up and down inside it (anim_bob) over the kelly turning in the
    # rotary table (anim_spin); the doghouse off the floor's back, the engine
    # house behind with its two stacks, two rust mud tanks, and the catwalk
    # ramping down from the V-door beside the rack of drill pipe lying along
    # the road. The lap's one derrick, in steel and paint, never the timber
    # of Gulch's headframe.
    with plain_parts():
        ground_poly([(-4.4, 0.03, -7.2), (3.4, 0.03, -7.2), (3.4, 0.03, 4.0), (-4.4, 0.03, 4.0)],
                    [(0, 1, 2, 3)], 0xb8a686)
        # the substructure and the floor, the blowout preventer under it
        for sx in (-1, 1):
            for sz in (-1, 1):
                box((0.3, 0.84, 0.3), (sx * 1.35, 0.42, sz * 1.35), 'grey')
        for (a, b) in (((-1.35, -1.35), (-1.35, 1.35)), ((-1.35, -1.35), (1.35, -1.35))):
            strut((a[0], 0.1, a[1]), (b[0], 0.78, b[1]), 0.1, 'grey')
            strut((b[0], 0.1, b[1]), (a[0], 0.78, a[1]), 0.1, 'grey')
        box((3.0, 0.18, 3.0), (0, 0.91, 0), 'grey')
        cyl(0.46, 0.2, (0, 0, 0), 'red', segs=10)
        cyl(0.34, 0.36, (0, 0.2, 0), 'red', segs=10)
        box((0.9, 0.22, 0.6), (0, 0.66, 0), 'red')
        cyl(0.4, 0.08, (0, 0.995, 0), 'slate', segs=10)                         # the rotary table
        # the mast: four legs from the floor's corners leaning in to the crown
        H0, H1, W0, W1 = 1.0, 6.5, 1.3, 0.35
        def w(y):
            return W0 + (W1 - W0) * (y - H0) / (H1 - H0)
        for sx in (-1, 1):
            for sz in (-1, 1):
                strut((sx * W0, H0, sz * W0), (sx * W1, H1, sz * W1), 0.16, 'white')
        lv = (H0, 2.3, 3.5, 4.6, 5.6)
        for k, y in enumerate(lv[1:]):
            col = 'red' if k >= 2 else 'white'
            for s_ in (-1, 1):
                box((2 * w(y) + 0.1, 0.12, 0.12), (0, y, s_ * w(y)), col)
                box((0.12, 0.1, 2 * w(y + 0.03) + 0.1), (s_ * w(y + 0.03), y + 0.03, 0), col)
        for y0, y1 in zip(lv, lv[1:]):                                          # a brace up each face
            for a, b in (((1, 1), (1, -1)), ((-1, -1), (-1, 1)), ((1, -1), (-1, -1)), ((-1, 1), (1, 1))):
                strut((a[0] * w(y0), y0, a[1] * w(y0)), (b[0] * w(y1), y1, b[1] * w(y1)), 0.1, 'white')
        box((1.0, 0.14, 1.0), (0, H1 + 0.07, 0), 'white')
        box((0.8, 0.4, 0.6), (0, H1 + 0.34, 0), 'red')                          # the crown block
        box((0.06, 0.9, 0.06), (0, H1 + 0.99, 0), 'white')                      # the flag's pole
    with animated('anim_sway:a=x:d=20:p=2.6#flag', (0, H1 + 1.44, 0)), plain_parts():
        box((0.06, 0.5, 0.8), (0, H1 + 1.18, 0.43), 'red')
        for side, yaw in ((0.03, 0.0), (-0.03, math.pi)):
            emblem((side, H1 + 1.18, 0.43), yaw, 0.17)
    with animated('anim_bob:h=3:p=12:r=0.4#block', (0, 2.7, 0)), plain_parts():
        box((0.36, 0.55, 0.3), (0, 2.7, 0), 'yellow')                            # the travelling block
        box((0.12, 0.25, 0.12), (0, 2.3, 0), 'slate')                            # its hook
    with animated('anim_spin:a=y:w=0.8#kelly', (0, 1.0, 0)), plain_parts():
        box((0.16, 1.1, 0.16), (0, 1.6, 0), 'slate')
    with plain_parts():
        # the doghouse off the floor's back, on stilts
        box((1.4, 1.0, 1.0), (-2.25, 1.5, 0.7), 0xc0392b)
        box((1.5, 0.1, 1.1), (-2.25, 2.05, 0.7), 'white')
        box((0.04, 0.3, 0.44), (-2.97, 1.62, 0.7), 0x8ecae6)
        for z in (0.3, 1.1):
            box((0.18, 0.98, 0.18), (-2.8, 0.49, z), 'grey')
        # the engine house behind, two stacks on it
        box((2.4, 1.2, 1.4), (0, 0.6, 2.8), 'grey')
        box((2.5, 0.1, 1.5), (0, 1.25, 2.8), 'white')
        box((0.6, 0.72, 0.04), (0.6, 0.38, 3.52), 'slate')
        for x in (-0.6, 0.3):
            cyl(0.13, 0.7, (x, 1.3, 3.0), 'grey', segs=10, stem=True, smooth=True)
            cyl(0.16, 0.08, (x, 1.96, 3.0), 'slate', segs=10)
        # the mud tanks and their line to the floor
        for x in (-2.6, -3.6):
            box((0.8, 1.0, 3.0), (x, 0.5, -2.7), 'brown')
            for z in (-3.6, -1.9):
                box((0.3, 0.24, 0.3), (x, 1.12, z), 'slate')
        strut((-2.2, 0.86, -1.5), (-0.5, 0.86, -0.5), 0.1, 'slate')
        # the V-door's ramp down to the catwalk, the pipe rack beside it
        box((0.6, 0.08, math.hypot(1.7, 0.55)), (0, 0.725, -2.35), 'grey', pitch=math.atan2(0.55, 1.7))
        box((0.7, 0.45, 3.0), (0, 0.225, -4.7), 'grey')
        for z in (-3.4, -6.0):
            box((2.7, 0.18, 0.22), (1.75, 0.09, z), 'slate')                     # the rack's beams
            for x in (0.5, 3.0):
                box((0.1, 0.5, 0.1), (x, 0.25, z), 'slate')                      # their stops
        pipes = [(0.75 + 0.3 * i, 0.27) for i in range(7)] + [(0.9 + 0.3 * i, 0.38) for i in range(5)]
        for x, y in pipes:                                                       # the drill pipe, round,
            cyl(0.09, 4.0, (x, y, -6.7), 'lavender', segs=10, axis='along', stem=True, smooth=True)
            cyl(0.105, 0.08, (x, y, -2.74), 'white', segs=8, axis='along')     # its protectors to the S
    # the company's pickup by the engine house, in no racer's colour
    pickup(-3.4, 2.6, 0xfdf4de, yaw=0.3)
    join_still('rig')

@piece(1.25)
@plain
def well_pad():
    # Sidewinder: a lone pumpjack on its own well pad outside the east bend,
    # dead ahead out of the S between the rig and the tank farm: the field's
    # biggest jack (a quarter bigger than the field's three, grown), in the
    # company's red with a white horsehead, its beam broadside to the S
    # (bearing JAW), nodding slowly; its white lease tank past its wellhead,
    # beside it as the S sees it, wearing the company's mark toward the S
    # (bearing SEEN); a flush dirt pad under both.
    JAW, SEEN = math.radians(-52.0), math.radians(37.7)
    c, s_ = math.cos(JAW), math.sin(JAW)
    pad = [(-2.6, -1.6), (3.5, -1.6), (3.5, 1.6), (-2.6, 1.6)]
    ground_poly([(x * c + z * s_, 0.03, -x * s_ + z * c) for x, z in pad], [(0, 1, 2, 3)], 0xb8a686)
    pumpjack(0.0, 0.0, JAW, 'lone', 6.0, paint=('red', 'white', 'slate'))
    TR = 0.72
    TX, TZ = 2.6 * c, -2.6 * s_
    cyl(TR, 1.12, (TX, 0, TZ), 'white', segs=14)
    cyl(TR + 0.03, 0.08, (TX, 1.12, TZ), 'slate', segs=14)
    emblem((TX + (TR - 0.1) * math.cos(SEEN), 0.62, TZ - (TR - 0.1) * math.sin(SEEN)), SEEN, 0.3, d=0.14)
    join_still('wellpad')

@piece(1.0)
@plain
def wellhead():
    # Sidewinder: a flowing well past the lone jack, at the east bend's exit:
    # no pump on it, only its christmas tree, at a real one's size beside a
    # car: the casing head on its cellar collar, two red master valves with
    # white hand wheels, the cross with a wing valve each side, one turned
    # down to the flowline going into the ground, a gauge on the cap; a
    # flush dirt pad (+X is the road).
    ground_poly([(-1.5, 0.03, -1.5), (1.5, 0.03, -1.5), (1.5, 0.03, 1.5), (-1.5, 0.03, 1.5)],
                [(0, 1, 2, 3)], 0xb8a686)
    cyl(0.45, 0.14, (0, 0, 0), 'slate', segs=12)                                # the cellar's collar
    cyl(0.32, 0.3, (0, 0.14, 0), 'grey', segs=12)                               # the casing head
    cyl(0.14, 1.1, (0, 0.44, 0), 'grey', segs=10)                               # the spool through
    for y in (0.44, 0.84):                                                      # the master valves
        box((0.36, 0.32, 0.36), (0, y + 0.16, 0), 'red')
        cyl(0.2, 0.05, (0.18, y + 0.16, 0), 'white', segs=12, axis='across')    # a hand wheel
    box((0.28, 0.28, 1.3), (0, 1.38, 0), 'red')                                 # the cross
    for sz in (-1, 1):
        box((0.36, 0.34, 0.3), (0, 1.38, sz * 0.8), 'red')                      # its wing valves
        cyl(0.18, 0.05, (0, 1.55, sz * 0.8), 'white', segs=12)                  # their wheels, on top
    strut((0, 1.38, 0.95), (0, 0.03, 1.4), 0.14, 'slate')                       # the flowline, down
    cyl(0.2, 0.3, (0, 1.52, 0), 'white', segs=12)                               # the cap
    cyl(0.05, 0.2, (0.0, 1.82, 0), 'slate', segs=10)                            # the gauge's stem
    cyl(0.16, 0.06, (0.0, 2.05, -0.03), 'white', segs=12, axis='along')         # the gauge
    join_still('wellhead')

@piece(0.6)
@plain
def headframe():
    # Gulch: the far end of the mine's ore line, where a shaft goes straight
    # down: a timber headframe over the shaft at a big real one's height
    # (some thirty metres, eight car lengths, so its wheel shows over the
    # east bend; the builder's units are 1/0.6 of the world's), its back
    # legs braced toward the hoist house (-X) the cable comes from, the
    # sheave wheel on top turning as the cage winds (anim_spin), the cable
    # over it and down into the shaft's collar house. The skips tip into the
    # ore bin standing out of the frame's front on its own legs, and the ore
    # line (set-ore-line) runs in from +X under it, into the loading shed
    # between the bin's legs: its train comes out of the shed loaded, past
    # the buffer stop's siding. The hoist house is a boarded engine house
    # under a tin roof, the cable through its gable, its boiler's iron stack
    # nearly as tall as the headframe, guyed, smoke rising from it
    # (anim_smoke): the working mine's mark on the skyline from across the
    # map; cordwood for the boiler stacked by its wall.
    H = 9.0
    for sx in (-1, 1):                                                           # four legs, leaning in
        for sz in (-1, 1):
            strut((sx * 1.6, 0, sz * 1.4), (sx * 0.8, H, sz * 0.8), 0.34, TIMBER)
    for y in (3.0, 6.0):                                                         # girts
        w, wz = 1.6 - 0.8 * y / H, 1.4 - 0.6 * y / H
        for s in (-1, 1):
            box((2 * w + 0.3, 0.22, 0.22), (0, y, s * wz), TIMBER)
            box((0.22, 0.22, 2 * wz + 0.3), (s * w, y, 0), TIMBER)
    for s in (-1, 1):                                                            # braces on the sides
        strut((-1.6, 0.3, s * 1.4), (1.07, 5.9, s * 1.0), 0.16, TIMBER)
    for sz in (-1, 1):                                                           # the back legs
        strut((-6.2, 0, sz * 1.1), (-0.7, H - 0.4, sz * 0.8), 0.32, TIMBER)
        strut((-3.4, 0, sz * 1.0), (-3.0, 4.4, sz * 0.95), 0.2, TIMBER)
    box((2.8, 0.3, 2.4), (0, H, 0), TIMBER)                                      # the sheave deck
    cy = H + 1.75
    for sz in (-1, 1):
        box((0.3, 1.9, 0.3), (0, H + 0.95, sz * 0.75), TIMBER)
    box((0.3, 0.3, 1.9), (0, cy, 0), 'slate')                                    # the axle
    with animated('anim_spin:a=z:w=-1.5', (0, cy, 0)):                          # the wheel turns
        torus(1.45, 0.14, (0, cy, 0), 'red', segs=16, axis='along')
        for k in range(4):
            box((0.2, 2.8, 0.2), (0, cy, 0), 'red', roll=k * math.pi / 4)
        box((0.55, 0.55, 0.5), (0, cy, 0), 'slate')
    strut((-6.6, 3.0, 0), (-1.0, cy + 1.1, 0), 0.12, ROPE)                      # the cable from the drum
    strut((-0.9, cy, 0), (-0.9, 2.2, 0), 0.12, ROPE)                            # and down the shaft
    box((2.0, 2.2, 2.2), (-0.7, 1.1, 0), BOARD)                                  # the collar house over the shaft
    box((2.2, 0.16, 2.4), (-0.7, 2.28, 0), RUST)
    box((0.08, 1.5, 1.0), (-1.72, 0.75, 0), 'dark')                              # its gate
    # the ore bin before the frame, on legs astride the line, clear of the
    # frame's own; the loading shed between them, open to the line (+X)
    for sx in (1.95, 4.5):
        for sz in (-1, 1):
            box((0.3, 3.2, 0.3), (sx, 1.6, sz * 1.05), TIMBER)
    for sz in (-1, 1):
        box((2.95, 1.9, 0.14), (3.22, 0.95, sz * 1.05), BOARD)                   # the shed's walls
    box((0.14, 1.9, 2.1), (1.75, 0.95, 0), BOARD)                                # and its back
    box((3.1, 0.24, 2.6), (3.22, 3.2, 0), TIMBER)                                # the bin's floor
    solid([(1.9, 3.3, -1.1), (4.6, 3.3, -1.1), (4.6, 3.3, 1.1), (1.9, 3.3, 1.1),
           (1.7, 5.2, -1.3), (4.8, 5.2, -1.3), (4.8, 5.2, 1.3), (1.7, 5.2, 1.3)],
          [(3, 2, 1, 0), (4, 5, 6, 7)] + [(i, (i + 1) % 4, 4 + (i + 1) % 4, 4 + i) for i in range(4)], BOARD)
    for y in (3.9, 4.7):                                                         # its iron bands
        f = (y - 3.3) / 1.9
        box((2.74 + 0.4 * f, 0.12, 2.24 + 0.4 * f), (3.25, y, 0), 'slate')
    rock_lump(1.2, (3.25, 5.15, 0), 'yellow', (1.1, 0.35, 0.95), 0.3, seed=2.0)  # ore heaped in it
    strut((0.3, 6.6, 0), (2.2, 5.5, 0), 0.5, TIMBER)                             # the skips' chute into it
    for s in (-1, 1):                                                            # a ladder up a leg, clear of the carts
        box((0.12, 6.0, 0.12), (-1.9, 3.0, -1.2 + s * 0.25), TIMBER)
    for i in range(7):
        box((0.12, 0.1, 0.5), (-1.9, 0.6 + i * 0.8, -1.2), TIMBER)
    # the hoist house: its ridge along the cable, the cable through its gable
    frame_house((-8.8, 0, 0), math.pi / 2, 3.6, 4.2, 2.5, 1.2, BOARD, RUST, k=1.67, door=('-x', -0.9, 0.9, 1.8, TIMBER),
                windows=(('+x', -1.0, 1.5, 0.8, 0.9), ('+x', 1.0, 1.5, 0.8, 0.9), ('-x', 0.9, 1.5, 0.8, 0.9)), battens=0)
    box((0.1, 0.5, 0.5), (-6.68, 3.0, 0), 'dark')                                # where the cable comes out
    SX, SZ, SH = -10.2, -2.9, 9.6                                                # the boiler's stack
    cyl(0.62, 0.9, (SX, 0, SZ), 0xa96545, segs=8)
    cyl(0.4, SH, (SX, 0, SZ), 'slate', r2=0.33, segs=8, stem=True)
    cyl(0.46, 0.4, (SX, SH - 0.4, SZ), 0x8a4a32, segs=8)
    for a in (() if LITE else (0.6, 2.7, 4.8)):                                  # its guys
        strut((SX, SH * 0.72, SZ), (SX + 3.2 * math.cos(a), 0.0, SZ + 3.2 * math.sin(a)), 0.05, ROPE)
    marker('anim_smoke:s=2.4', (SX, SH + 0.1, SZ))                              # a stack's smoke, not a chimney's
    for i in range(0 if LITE else 3):                                            # cordwood for the boiler
        for j in range(3 - i):
            cyl(0.2, 1.5, (-7.7, 0.2 + 0.36 * i, 2.5 + 0.42 * j + 0.21 * i), 0x8a6a46, segs=6, axis='across', stem=True)

lite_too('boomtown-north', 'boomtown-south', 'miners-camp', 'stamp-mill', 'headframe', 'tailings-dump',
         'ranch-herd', 'ranch-herd-east')

# ====================================================================================
# PLAYROOM
# ====================================================================================

def quad(pts, color, parent=None):
    """One flat face through four glTF points, counter-clockwise seen from the
    side it shows: paint on a surface (a letter on a block, a pip on a domino).
    With `parent`, the points are in that object's own frame."""
    me = bpy.data.meshes.new('quad')
    me.from_pydata([tuple(P(*v)) for v in pts], [], [(0, 1, 2, 3)])
    me.update()
    o = bpy.data.objects.new('quad', me)
    bpy.context.scene.collection.objects.link(o)
    if parent is not None:
        o.parent = parent
    return paint(o, color)

# a face of a box: (outward normal, the viewer's right), both glTF
FACES = {'+x': ((1, 0, 0), (0, 0, -1)), '-x': ((-1, 0, 0), (0, 0, 1)),
         '+z': ((0, 0, 1), (1, 0, 0)), '-z': ((0, 0, -1), (-1, 0, 0))}

def plate_x(x, y0, y1, z0, z1, color):
    """A painted rectangle facing +X (the road) at `x`."""
    return quad([(x, y0, z1), (x, y0, z0), (x, y1, z0), (x, y1, z1)], color)

def merge_paint():
    """Join the painted faces of a piece into one object per swatch, so a run
    of letters or pips costs a node, not one each."""
    groups = {}
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and o.name.startswith('quad'):
            groups.setdefault(o['swatch'], []).append(o)
    for objs in groups.values():
        if len(objs) < 2:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()

def face_rect(o, face, d, u0, u1, v0, v1, color):
    """A painted rectangle on `face` of `o`, `d` out from its centre, u along
    the viewer's right and v up (both in o's frame)."""
    n, r = FACES[face]
    pts = [tuple(n[i] * d + r[i] * u + (v if i == 1 else 0) for i in range(3))
           for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]
    return quad(pts, color, parent=o)

# block letters on a 5 x 5 grid: (col0, row0, col1, row1) bars, row 0 at the foot
GLYPH = {
    'A': ((0, 0, 0, 4), (4, 0, 4, 4), (1, 4, 3, 4), (1, 2, 3, 2)),
    'B': ((0, 0, 0, 4), (1, 4, 3, 4), (1, 2, 3, 2), (1, 0, 3, 0), (4, 3, 4, 3), (4, 1, 4, 1)),
    'C': ((0, 1, 0, 3), (1, 4, 4, 4), (1, 0, 4, 0)),
    'D': ((0, 0, 0, 4), (1, 4, 3, 4), (1, 0, 3, 0), (4, 1, 4, 3)),
    'E': ((0, 0, 0, 4), (1, 4, 4, 4), (1, 2, 3, 2), (1, 0, 4, 0)),
    'H': ((0, 0, 0, 4), (4, 0, 4, 4), (1, 2, 3, 2)),
    'L': ((0, 0, 0, 4), (1, 0, 4, 0)),
    'T': ((0, 4, 4, 4), (2, 0, 2, 3)),
    'P': ((0, 0, 0, 4), (1, 4, 3, 4), (1, 2, 3, 2), (4, 3, 4, 3)),
}
ABC = 'ABCDEHLT'

def block(size, at, color, yaw=0.0, roll=0.0, pitch=0.0, letters=None, faces=('+x', '-x', '+z', '-z', '+y')):
    """An alphabet block: a coloured cube with a cream panel on each of `faces`
    and a letter in the block's colour on the faces `letters` names
    ({'+x': 'A', ...})."""
    box((size, size, size), at, color, yaw=yaw, roll=roll, pitch=pitch)
    pw, t = size * 0.72, 0.06
    off = size / 2 + t / 2 - 0.005
    o = bpy.context.active_object
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    plates = {'+x': (off, 0, 0, t, pw, pw), '-x': (-off, 0, 0, t, pw, pw), '+z': (0, 0, off, pw, pw, t),
              '-z': (0, 0, -off, pw, pw, t), '+y': (0, off, 0, pw, t, pw)}
    for k in faces:
        p = plates[k]
        bpy.ops.mesh.primitive_cube_add(size=1.0)
        f = bpy.context.active_object
        f.scale = (p[3], p[5], p[4])
        f.location = P(p[0], p[1], p[2])
        paint(f, 0xfdf4de)
        f.parent = o
    cell = size * 0.56 / 5
    for k, ch in (letters or {}).items():
        for c0, r0, c1, r1 in GLYPH[ch]:
            face_rect(o, k, size / 2 + t - 0.005 + 0.012, (c0 - 2.5) * cell, (c1 - 1.5) * cell,
                      (r0 - 2.5) * cell, (r1 - 1.5) * cell, color)
    return o

def rollxy(x, y, r):
    """Where (x, y) goes under a `roll` of r (place(): about the along axis;
    a positive roll swings up toward +X)."""
    return x * math.cos(r) + y * math.sin(r), -x * math.sin(r) + y * math.cos(r)

TOY = [0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c]

# ---- the playroom ---------------------------------------------------------------
# Indoors the scale is the TOY car's: a racer is a 5 cm toy car, so 1 unit is
# about 5.5 cm, and every toy here stands at its real size beside one (a
# little chunkier, as a toy is): a board game about 11 across, a wooden snake
# as thick as a car is tall, a toy dragon 4 tall, a castle of blocks 10
# across, a marble run 9 high. Nothing from the grown-ups' world: at this
# scale a book or a sofa is terrain, not a prop.

def slinky():
    # Helix: a rainbow slinky walking down off a big alphabet block (built at
    # the marble tower's grow, 0.65, which stands it beside; a stack of books
    # was a grown-up's thing among the toys). ONE coiled wire, its ends
    # bunched (a stack on the block, a stack on the floor), the arch between
    # them opened out so the gaps between the coils show: that
    # spring-and-gap is what says slinky. Each colour is a band of coils.
    TOPY = 2.3
    block(TOPY, (-3.4, TOPY / 2, 0.0), 0xf2c14e, yaw=0.06, letters={'+z': 'A', '+x': 'B', '-z': 'C', '-x': 'D'})
    R, WIRE, TIGHT, OPEN, NEND = 1.0, 0.1, 0.24, 0.7, 6
    a0 = (-3.4, TOPY + WIRE + 0.02)
    b0 = (4.0, WIRE + 0.02)
    a1 = (a0[0], a0[1] + NEND * TIGHT)
    b1 = (b0[0], b0[1] + NEND * TIGHT)
    K = 4.6
    def bez(t):
        p = [a1, (a1[0], a1[1] + K), (b1[0], b1[1] + K), b1]
        m = 1 - t
        w = (m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t)
        return (sum(w[i] * p[i][0] for i in range(4)), sum(w[i] * p[i][1] for i in range(4)))
    # the centre line: up the top stack, over the arch, down the floor stack
    line = [(a0[0], a0[1] + (a1[1] - a0[1]) * i / 40) for i in range(40)]
    line += [bez(i / 400) for i in range(400)]
    line += [(b1[0], b1[1] - (b1[1] - b0[1]) * i / 40) for i in range(41)]
    seg = [math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]) for i in range(len(line) - 1)]
    stack = NEND * TIGHT
    arch = sum(seg) - 2 * stack
    nopen = max(1, round(arch / OPEN))
    def pitch(s):
        return TIGHT if s < stack or s > stack + arch else arch / nopen
    # march the helix round the line, eight points a coil
    pts, s, th, nxt = [], 0.0, 0.0, 0.0
    STEP = 2 * math.pi / 8
    for i in range(len(seg)):
        (x0, y0), (x1, y1) = line[i], line[i + 1]
        tx, ty = (x1 - x0) / (seg[i] or 1), (y1 - y0) / (seg[i] or 1)
        dth = 2 * math.pi * seg[i] / pitch(s)
        while nxt <= th + dth:
            f = (nxt - th) / dth
            cx, cy = x0 + (x1 - x0) * f, y0 + (y1 - y0) * f
            pts.append((cx - ty * R * math.cos(nxt), cy + tx * R * math.cos(nxt), R * math.sin(nxt)))
            nxt += STEP
        th += dth
        s += seg[i]
    RAIN = [0xff5040, 0xff7e44, 0xffc044, 0x6cbf6c, 0x339cf2, 0xa878e8]
    BAND = 3 * 8                                  # three coils a colour
    for k in range(0, len(pts) - 1, BAND):
        tube(pts[k:k + BAND + 1], WIRE, RAIN[(k // BAND) % 6], res=1, bevel_res=0)
        bpy.ops.object.shade_smooth()

@piece(1.0)
def castle_gate():
    # Gauntlet: the home straight runs THROUGH the block castle's gatehouse,
    # the castle itself standing beside the road just short of it. Placed at
    # lat 0, so x = 0 is the road's centreline (deck 5 wide, kerbs to 2.76),
    # +Z the way the racers drive and +X their left. Built from the castle's
    # own blocks (block_fortress's, a little smaller): only the towers are
    # taller than the castle's walls, because the lintel must clear the road. A
    # tower of five blocks on each kerb (inner faces 4 u off the centreline,
    # past the road's 1.2 u margin) and a lintel of seven blocks between
    # them, its underside 3.6 up: 3.18 over the deck top, past spotIssue's
    # OVER_GAP 3 and the highest camera's 2.6. From each tower a short wall
    # runs straight AWAY from the road, two blocks with a crenel on each:
    # never along the kerb. Nothing moves: indoors nothing flaps.
    S = 1.12                                                  # the castle's block
    for sx in (-1, 1):
        x = sx * (4.0 + S / 2)
        road = '-x' if sx > 0 else '+x'                       # the face turned to the road
        for j in range(5):
            block(S, (x, S / 2 + j * S, 0), TOY[(j + (sx > 0)) % 4], faces=('-z', road),
                  letters={'-z': ABC[(2 * j + (sx > 0)) % 8]})
        cyl(S * 0.78, S * 0.9, (x, 5 * S, 0), 0x6cbf6c if sx > 0 else 0xe66a5a, r2=0.05, segs=10)
    L, LY = 8.0 / 7, 3.6                                      # the lintel's blocks, its underside
    for i in range(7):
        block(L, ((i - 3) * L, LY + L / 2, 0), TOY[(i + 2) % 4], faces=('-z',),
              letters={'-z': 'LHEDCBA'[i]})                   # +X is the racer's left: it reads A to L
    # the gateway's dark soffit, hung 0.08 under the lintel's blocks: its
    # underside in their plane flickered against them from the road
    box((7 * L - 0.04, 0.16, S * 0.9), (0, LY, 0), 0x3a2a22)
    for i in (-3, -1, 1, 3):                                          # crenels along the lintel
        box((S * 0.6, S * 0.5, S * 0.6), (i * L, LY + L + S * 0.25, 0), 0xf2c14e)
    # the walls away from the road
    for sx in (-1, 1):
        for k in range(2):
            x = sx * (4.0 + S + S / 2 + k * S)
            for j in range(2):
                block(S, (x, S / 2 + j * S, 0), TOY[(k + j + 1) % 4], faces=('-z',),
                      letters={'-z': ABC[(k + 3 * j + 2) % 8]} if j == 0 else None)
            box((S * 0.6, S * 0.5, S * 0.6), (x, 2 * S + S * 0.25, 0), 0xf2c14e)
    merge_paint()

@piece(0.45)
def spinning_top():
    # Helix: a tin humming top (about 16 cm across and 20 cm to its knob, the
    # biggest tops there are) spinning on its point, the screw of its pump a
    # helix of its own, and a wooden top (about 6 cm) spinning beside it with
    # its pull string thrown down on the floor. Each PRECESSES as a top does:
    # it spins fast about its own axis, leaned off upright, and that axis
    # walks slowly round the upright on its point, the same way round (a
    # leaned spin riding an upright one). The wooden one is further run down:
    # leaned more, its axis circling faster. The point is the upright part:
    # a part with nothing drawn is no node for the lean to ride.
    with animated('anim_spin:w=1.5#a', (0, 0, 0)):
        cyl(0.15, 0.6, (0, 0, 0), 0x2a2735, r2=0.6, segs=8)                          # the point
        with animated('anim_spin:w=5.0#a', (0, 0, 0), tilt=0.12):
            humming_top_body()
    x, z, k = -1.5, 6.4, 0.75
    with animated('anim_spin:w=-2.6#b', (x, 0, z)):
        cyl(0.06 * k, 0.4 * k, (x, 0, z), 0x2a2735, r2=0.32 * k, segs=10)
        with animated('anim_spin:w=-7.0#b', (x, 0, z), tilt=0.2):
            spinning_top_body(x, z, k)
    tube([(-0.5, 0.1, 4.6), (-0.2, 0.1, 3.8), (0.9, 0.1, 3.9), (1.9, 0.1, 4.6), (2.6, 0.1, 4.2)], 0.05, 0xfff6eb, res=3, bevel_res=0)
    box((0.3, 0.3, 1.4), (2.9, 0.15, 3.9), 0x9a7b55, yaw=0.9)

def humming_top_body():
    # tin: a cone up from the point to a fat yellow belly band, a painted dome
    # over it with panels that show it turning, the collar, and the pump: a
    # bar with its screw wound round it and a red knob
    cyl(0.6, 1.6, (0, 0.6, 0), 0xe66a5a, r2=3.3, segs=10)
    cyl(3.4, 0.5, (0, 2.2, 0), 0xf2c14e, segs=10)
    cyl(3.3, 1.6, (0, 2.7, 0), 0x5a8fd8, r2=1.4, segs=10)
    for j in range(6):
        a = j * math.pi / 3
        box((0.16, 1.4, 1.0), (math.cos(a) * 2.5, 3.45, math.sin(a) * 2.5), (0xfdf4de, 0xe66a5a)[j % 2], yaw=-a, roll=-0.87)
    cyl(1.4, 0.4, (0, 4.3, 0), 0xf2c14e, r2=0.8, segs=10)
    box((0.4, 3.2, 0.4), (0, 6.2, 0), 0x9aa1b4)
    tube(helix_pts(0, 0, 0.36, 4.8, 7.4, 0.0, 3, per=5), 0.08, 0x9aa1b4, res=1, bevel_res=0)
    cyl(0.8, 0.7, (0, 7.7, 0), 0xe66a5a, r2=0.55, segs=10)

def spinning_top_body(x, z, k):
    cyl(0.32 * k, 1.2 * k, (x, 0.4 * k, z), 0xe66a5a, r2=1.7 * k, segs=10)          # the belly
    cyl(1.76 * k, 0.32 * k, (x, 1.6 * k, z), 0xffc044, segs=10)                      # the rim
    cyl(1.7 * k, 0.75 * k, (x, 1.92 * k, z), 0x5a8fd8, r2=0.95 * k, segs=10)         # the shoulder
    cyl(0.95 * k, 0.25 * k, (x, 2.67 * k, z), 0xffc044, r2=0.55 * k, segs=10)        # the crown
    box((0.34 * k, 1.2 * k, 0.34 * k), (x, 3.4 * k, z), 0x9a7b55)                    # the handle
    box((0.52 * k, 0.4 * k, 0.52 * k), (x, 4.1 * k, z), 0x6cbf6c)
    for y in (0.93, 1.35) if k == 1 else ():      # stripes hugging the big one's belly
        torus((0.32 + 1.38 * (y - 0.4) / 1.2 + 0.03) * k, 0.05, (x, y * k, z), 0xfdf4de, segs=10)
    for j in range(4):                            # bands round the shoulder: they show it turning
        a = j * math.pi / 2
        box((0.5 * k, 0.7 * k, 0.14 * k), (x + math.cos(a) * 1.35 * k, 2.3 * k, z + math.sin(a) * 1.35 * k), 0xe66a5a, yaw=-a)

@piece(0.7)
def toy_dragon():
    # Gauntlet: the castle's toy dragon (a moulded one from the knights' set,
    # about 25 cm to its wing tips and 40 cm nose to tail) standing guard
    # before the castle, side on to the road (+X), its head toward the cars
    # coming at it (-Z). It flaps its wings, slowly, both in step, and now
    # and then turns its head to the road and back. Its tail curls down to
    # the floor behind it.
    GREEN, BELLY, WING, HORN = 0x6cbf6c, 0xf2c14e, 0xa878e8, 0xfdf4de
    for z in (-1.1, 1.1):                                                     # the legs, claws forward
        for sx in (-1, 1):
            box((0.7, 1.5, 0.7), (sx * 0.72, 0.75, z), GREEN)
            box((0.8, 0.3, 1.0), (sx * 0.72, 0.15, z - 0.2), BELLY)
    box((1.9, 1.7, 3.4), (0, 2.2, 0), GREEN)                                  # the body
    box((1.4, 0.3, 3.0), (0, 1.28, 0), BELLY)                                 # its belly
    box((1.7, 1.5, 1.2), (0, 2.6, -1.9), GREEN)                               # the chest
    bar((0, 2.9, -2.1), (0, 4.6, -3.0), 1.0, 1.0, GREEN)                      # the neck
    for z in (-1.4, -0.5, 0.4, 1.3):                                          # spines down the back
        cyl(0.32, 0.6, (0, 3.0, z), BELLY, r2=0.02, segs=4)
    # the tail, thick to thin, down to the floor and curling off behind
    tube([(0, 2.2, 1.5), (0.2, 1.7, 3.0), (0.8, 0.9, 4.2), (0.9, 0.5, 5.0)], 0.5, GREEN, res=3, bevel_res=1)
    tube([(0.9, 0.5, 5.0), (0.6, 0.32, 5.8), (-0.4, 0.32, 6.3)], 0.3, GREEN, res=3, bevel_res=0)
    box((0.9, 0.16, 0.9), (-0.85, 0.08, 6.45), BELLY, yaw=math.pi / 4)        # its spade
    # The head turns to the road (+X) and back once in a while: a gesture.
    with animated('anim_sway:a=y:d=-32:p=7:r=0.6#head', (0, 4.6, -3.0)):
        box((1.3, 1.1, 1.7), (0, 5.0, -3.5), GREEN)
        box((1.0, 0.7, 1.1), (0, 4.75, -4.7), GREEN)                          # the snout
        box((0.9, 0.16, 1.0), (0, 4.35, -4.7), BELLY)                         # the jaw's edge
        for sx in (-1, 1):
            box((0.3, 0.36, 0.42), (sx * 0.62, 5.25, -3.7), HORN)            # the eyes
            box((0.12, 0.22, 0.22), (sx * 0.78, 5.25, -3.8), 0x2a2735)
            box((0.12, 0.14, 0.14), (sx * 0.4, 4.95, -5.26), 0x2a2735)        # the nostrils
            bar((sx * 0.4, 5.45, -3.0), (sx * 0.55, 6.25, -2.35), 0.24, 0.24, HORN)   # the horns
    # The wings, raised from the shoulders: a bone along the top edge and
    # out to the tip, the membrane between them. They flap about the
    # shoulder's own line (Z), the two mirrored and in step.
    for sx in (-1, 1):
        root = (sx * 0.9, 3.0, -0.8)
        tip, back = (sx * 2.3, 6.2, -1.4), (sx * 2.9, 4.4, 1.6)
        with animated('anim_sway:a=z:d=%d:p=2.8:o=0#wing%d' % (18 * sx, sx), root):
            poly([(sx * 0.9, 3.0, -1.6), tip, back, (sx * 1.6, 3.6, 1.1), (sx * 0.9, 3.0, 0.6)],
                 [(0, 1, 2), (0, 2, 3), (0, 3, 4)], WING)
            bar((sx * 0.9, 3.0, -1.4), tip, 0.26, 0.26, GREEN)
            bar(tip, back, 0.22, 0.22, GREEN)
    merge_paint()


# ---- the playroom games ------------------------------------------------------
# Each playroom track is one game laid out on the floor (the pieces are built
# in world units, a car 0.9 long, so their GROW is 1): Skysnake snakes and
# ladders, Skyline a town of wooden blocks, Helix a marble run, Gauntlet a
# block castle under siege.

def bar(a, b, w, h, color, roll=0.0):
    """A box from glTF point a to b, `w` across and `h` up (strut's square bar,
    flattened): a ladder rail, a snake's joint."""
    dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
    return box((w, h, math.sqrt(dx * dx + dy * dy + dz * dz)), mid, color,
               yaw=math.atan2(dx, dz), pitch=math.atan2(dy, math.hypot(dx, dz)), roll=roll)

def curve(ctrl, step):
    """Points every `step` along a Catmull-Rom curve through `ctrl` [(x, z)]."""
    dense = []
    n = len(ctrl)
    for i in range(n - 1):
        p0, p1, p2, p3 = ctrl[max(i - 1, 0)], ctrl[i], ctrl[i + 1], ctrl[min(i + 2, n - 1)]
        for k in range(24):
            t = k / 24
            t2, t3 = t * t, t * t * t
            dense.append(tuple(0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2
                                      + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in range(2)))
    dense.append(ctrl[-1])
    out, run = [dense[0]], 0.0
    for a, b in zip(dense, dense[1:]):
        run += math.hypot(b[0] - a[0], b[1] - a[1])
        if run >= step:
            out.append(b)
            run = 0.0
    return out

def print_band(pts, y, w, color):
    """A flat printed band `w` wide along the points [(x, z)] at height `y`:
    a snake or a ladder's rail drawn on the board."""
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        l = math.hypot(x1 - x0, z1 - z0) or 1.0
        nx, nz = -(z1 - z0) / l * w / 2, (x1 - x0) / l * w / 2
        quad([(x0 - nx, y, z0 - nz), (x1 - nx, y, z1 - nz), (x1 + nx, y, z1 + nz), (x0 + nx, y, z0 + nz)], color)

def print_ladder(a, b, w, y, color):
    """A ladder printed on the board from (x, z) a to b, `w` wide."""
    l = math.hypot(b[0] - a[0], b[1] - a[1])
    nx, nz = -(b[1] - a[1]) / l * w / 2, (b[0] - a[0]) / l * w / 2
    for s in (-1, 1):
        print_band([(a[0] + s * nx, a[1] + s * nz), (b[0] + s * nx, b[1] + s * nz)], y, 0.14, color)
    n = max(2, int(l / 0.45))
    for k in range(1, n):
        f = k / n
        cx, cz = a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
        print_band([(cx - nx, cz - nz), (cx + nx, cz + nz)], y + 0.002, 0.1, color)

def keep_light(below):
    """A print on the floor (a board's squares, a rug's streets) keeps its
    colour: shade() would grey everything under a piece's tall parts as if
    it were the foot of a wall. Every part whose top is under `below`."""
    bpy.context.view_layer.update()
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and max((o.matrix_world @ v.co).z for v in o.data.vertices) < below:
            o['ramp'] = 0.15

PIP = {1: ((0, 0),), 2: ((-1, 1), (1, -1)), 3: ((-1, 1), (0, 0), (1, -1)),
       4: ((-1, 1), (1, 1), (-1, -1), (1, -1)), 5: ((-1, 1), (1, 1), (0, 0), (-1, -1), (1, -1)),
       6: ((-1, 1), (-1, 0), (-1, -1), (1, 1), (1, 0), (1, -1))}

def die(at, s, yaw, faces=(('+x', 5), ('-z', 3), ('+z', 4), ('-x', 2)), color=0xfdf4de, pip=0x2a2735):
    """A die (white unless `color`), its pips painted on the four sides."""
    box((s, s, s), (at[0], at[1] + s / 2, at[2]), color, yaw=yaw)
    o = bpy.context.active_object
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    p = s * 0.09
    for face, n in faces:
        for u, v in PIP[n]:
            face_rect(o, face, s / 2 + 0.012, u * s * 0.27 - p, u * s * 0.27 + p, v * s * 0.27 - p, v * s * 0.27 + p, pip)

def pawn(at, color, k=1.0):
    x, y, z = at
    cyl(0.75 * k, 0.3 * k, (x, y, z), color, segs=10)
    cyl(0.6 * k, 1.5 * k, (x, y + 0.3 * k, z), color, r2=0.25 * k, segs=10)
    sphere(0.5 * k, (x, y + 2.05 * k, z), color, subdiv=1)

SNAKE = (0x6cbf6c, 0xf2c14e)

def stand_open(B, phi):
    """Stand a folded board up like an open book: every part so far, built
    lying flat (face up, its fold the line x = 0), is cut at the fold and
    turned so the fold stands upright, the board's -Z edge on the floor and
    its face to +X, each half swung `phi` toward the face."""
    import bmesh
    bpy.ops.object.select_all(action='DESELECT')
    parts = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    c, s = math.cos(phi), math.sin(phi)
    for o in parts:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                               plane_co=(0, 0, 0), plane_no=(1, 0, 0))
        for v in bm.verts:
            x, y, z = v.co.x, v.co.z, -v.co.y                  # Blender -> (across, up, along)
            h, d = z + B, y                                    # stood on its -Z edge, face to +d
            sg = 1.0 if x > 0 else -1.0
            x, d = x * c - sg * d * s, sg * x * s + d * c      # each half swung toward the face
            v.co = P(d, h, x)
        bm.to_mesh(o.data)
        bm.free()
        o.data.update()

@piece(1.0)
def snakes_ladders():
    # Skysnake: a game of snakes and ladders past the dive's loop, outside
    # the bend the loop runs out into: a 60 cm board of a hundred squares (a
    # toy car fits on one) stood up half open like a book, its snakes and
    # ladders to the road (lying flat, it showed only a sliver over the
    # kerb), the pawns and two dice on the floor before it. The track's dive
    # is its snake and its climb a ladder.
    B, T = 5.5, 0.22
    box((2 * B + 0.25, T, 2 * B + 0.25), (0, T / 2, 0), 0xb06041)        # the board's edge
    box((2 * B, 0.04, 2 * B), (0, T + 0.02, 0), 0xfdf4de)                 # its printed face
    C = 2 * B / 10
    y = T + 0.06
    for i in range(10):
        for j in range(10):
            if (i + j) % 2:
                continue
            x0, z0 = -B + i * C, -B + j * C
            quad([(x0, y, z0), (x0 + C, y, z0), (x0 + C, y, z0 + C), (x0, y, z0 + C)], TOY[((i + j) // 2 + j) % 4])
    # the printed ladders and snakes
    for a, b in (((2.4, -4.1), (3.5, 1.4)), ((-4.6, -4.4), (-4.1, -0.6)), ((1.6, 2.0), (2.8, 4.8))):
        print_ladder(a, b, 0.75, y + 0.01, 0xb06041)
    for ctrl, c in (([(-2.5, 4.4), (-0.9, 3.0), (-2.6, 1.3), (-0.8, -0.5), (-1.6, -2.4)], 0x6cbf6c),
                    ([(4.6, 4.3), (3.6, 3.0), (4.6, 1.2), (4.0, -1.0)], 0xe66a5a),
                    ([(0.6, -1.2), (1.4, -2.4), (0.2, -3.4), (1.0, -4.7)], 0xa878e8)):
        pts = curve(ctrl, 0.3)
        print_band(pts, y + 0.02, 0.42, c)
        hx, hz = ctrl[0]
        quad([(hx - 0.35, y + 0.025, hz), (hx, y + 0.025, hz - 0.3), (hx + 0.35, y + 0.025, hz), (hx, y + 0.025, hz + 0.45)], c)
    keep_light(0.4)
    stand_open(B + 0.125, math.radians(28))
    pawn((3.4, 0, -1.2), 0xe66a5a, k=0.4)
    pawn((4.2, 0, 0.6), 0x5a8fd8, k=0.4)
    pawn((2.6, 0, 0.3), 0xa878e8, k=0.4)
    pawn((4.6, 0, -2.6), 0xf2c14e, k=0.4)
    die((5.4, 0, 1.6), 0.6, 0.4)
    die((5.9, 0, 0.4), 0.6, -0.3, faces=(('+x', 1), ('-z', 6), ('+z', 3), ('-x', 4)))
    merge_paint()

def toy_snake(ctrl, base, k, rear=None, tail=None, neck=None):
    """A jointed wooden toy snake lying along the curve through `ctrl` [(x,
    z)], its blocks alternating green and yellow with a gap at every joint,
    tapering to the tail, `k` its size, standing on `base(x, z)`. With `rear`
    (a direction (x, z)), its last joints rise and its head leans out that
    way; otherwise its head lies at the curve's end. `neck` names the rearing
    neck's motion (anim_), with its head. `tail` (n, degrees, period, lag)
    wiggles the tail's last n blocks the way the toy's joints let it: each
    block swings about the joint before it, riding the one before, each `lag`
    of a swing behind the one before (anim_sway in step), so a wave runs down
    to the tip."""
    joints = curve(ctrl, 1.4 * k)
    N = len(joints)
    def body(i):
        (x0, z0), (x1, z1) = joints[i], joints[i + 1]
        f = min(1.0, 0.55 + 0.45 * i / 8)
        g = 0.13 * k / max(math.hypot(x1 - x0, z1 - z0), 0.01)
        y = max(base(x0, z0), base(x1, z1)) + 0.5 * f * k
        bar((x0 + (x1 - x0) * g, y, z0 + (z1 - z0) * g), (x1 - (x1 - x0) * g, y, z1 - (z1 - z0) * g),
            1.25 * f * k, 1.0 * f * k, SNAKE[i % 2])
    if tail:
        n, deg, period, lag = tail
        with contextlib.ExitStack() as chain:
            for m in range(n):
                j = joints[n - m]
                chain.enter_context(animated('anim_sway:a=y:d=%g:p=%g:o=%.3f#tail%d' % (deg, period, (1.0 - m * lag) % 1.0, m),
                                             (j[0], base(*j), j[1])))
                body(n - 1 - m)
    for i in range(0 if not tail else tail[0], N - 1):
        body(i)
    def head(hx, hy, hz, d, pitch):
        yaw = math.atan2(d[0], d[1])
        box((1.5 * k, 1.05 * k, 2.4 * k), (hx, hy, hz), 0x6cbf6c, yaw=yaw, pitch=pitch)
        box((1.2 * k, 0.3 * k, 2.0 * k), (hx + d[0] * 0.15 * k, hy - 0.57 * k, hz + d[1] * 0.15 * k), 0xf2c14e,
            yaw=yaw, pitch=pitch)
        sx, sz = d[1], -d[0]
        for sd in (-1, 1):
            ex, ez = hx + d[0] * 0.45 * k + sx * sd * 0.62 * k, hz + d[1] * 0.45 * k + sz * sd * 0.62 * k
            box((0.42 * k, 0.42 * k, 0.42 * k), (ex, hy + 0.45 * k, ez), 0xfdf4de, yaw=yaw)
            box((0.22 * k, 0.26 * k, 0.26 * k), (ex + sx * sd * 0.14 * k + d[0] * 0.1 * k, hy + 0.47 * k,
                                                 ez + sz * sd * 0.14 * k + d[1] * 0.1 * k), 0x2a2735, yaw=yaw)
        tx, tz, ty = hx + d[0] * 1.2 * k, hz + d[1] * 1.2 * k, hy - 0.4 * k
        bar((tx, ty, tz), (tx + d[0] * 0.8 * k, ty - 0.1 * k, tz + d[1] * 0.8 * k), 0.14 * k, 0.08 * k, 0xff5040)
        for sd in (-1, 1):
            fx, fz = tx + d[0] * 0.8 * k, tz + d[1] * 0.8 * k
            bar((fx, ty - 0.1 * k, fz), (fx + d[0] * 0.35 * k + sx * sd * 0.2 * k, ty - 0.13 * k, fz + d[1] * 0.35 * k + sz * sd * 0.2 * k),
                0.12 * k, 0.08 * k, 0xff5040)
    (px, pz), (ex, ez) = joints[-2], joints[-1]
    if not rear:
        l = math.hypot(ex - px, ez - pz) or 1.0
        d = ((ex - px) / l, (ez - pz) / l)
        head(ex + d[0] * 1.0 * k, base(ex, ez) + 0.55 * k, ez + d[1] * 1.0 * k, d, 0.0)
        return
    d, nx, nz, y0 = rear, ex, ez, base(ex, ez)
    NECK = ((0, 0.55), (0.55, 1.5), (0.85, 2.5), (0.95, 3.5), (1.1, 4.4), (1.55, 5.2), (2.25, 5.7))
    with animated(neck, (nx, y0, nz)) if neck else contextlib.nullcontext():
        for i in range(len(NECK) - 1):
            (h0, a0), (h1, a1) = NECK[i], NECK[i + 1]
            bar((nx + d[0] * h0 * k, y0 + a0 * k, nz + d[1] * h0 * k), (nx + d[0] * h1 * k, y0 + a1 * k, nz + d[1] * h1 * k),
                1.15 * k, 1.05 * k, SNAKE[(N + i) % 2])
        head(nx + d[0] * 3.1 * k, y0 + 5.75 * k, nz + d[1] * 3.1 * k, d, -0.12)

@piece(1.0)
def jointed_snake():
    # Skysnake's hero: the board's snake come alive, a wooden jointed toy
    # snake (about 80 cm of it, as thick as a toy car is tall) lying in curves
    # on the floor inside the bend before the line. It rears up at its -Z end
    # and sways its head out over -X toward the racers coming at it down the
    # straight, and its tail wiggles joint by joint as the wooden toy's
    # does when it is shaken; a little one lies curled beside it, its own
    # tail wiggling (a still snake beside a live one read as a broken toy).
    # Its body runs along Z.
    toy_snake([(0.0, 7.4), (1.6, 5.0), (-1.6, 2.6), (1.4, 0.0), (-1.3, -2.4), (0.9, -4.6), (0.0, -6.4)],
              lambda x, z: 0.0, 0.62, rear=(-1.0, 0.0),
              tail=(5, 10, 2.2, 0.13), neck='anim_sway:a=y:d=24:p=3.3#neck')
    toy_snake([(-3.4, 7.8), (-4.6, 5.8), (-3.4, 4.0), (-4.5, 2.2)], lambda x, z: 0.0, 0.36,
              tail=(3, 14, 1.7, 0.15))

@piece(1.0)
def toy_snake_loop():
    # Skysnake: another of the game's wooden snakes slithering round on the
    # floor. Its body lies on an arc of its circle and it travels round the
    # circle head first (anim_path, facing its way), so every block follows
    # the one ahead along the curve, as a snake's body does. A traveller,
    # it leaves the sun bake: a shadow baked where it lay would stay behind.
    # Its head rears up as it goes, a cobra's, so it reads over a kerb. As
    # thick as the jointed snake (one game's snakes), on a ring wide enough
    # to read from the straight it lies at the end of. Built with its head at
    # +Z heading +X, where the loop starts.
    R, k, N = 3.4, 0.6, 64
    for i in range(N):
        a = math.radians(90.0 - 360.0 * i / N)
        marker('path_ring_%d' % i, (R * math.cos(a), 0, R * math.sin(a)))
    ctrl = [(R * math.cos(math.radians(a)), R * math.sin(math.radians(a))) for a in range(330, 89, -30)]
    with animated('anim_path:c=ring:p=14:f=1', (0, 0, R)):
        toy_snake(ctrl, lambda x, z: 0.0, k, rear=(1.0, 0.0))

@piece(1.0)
def game_box():
    # Skysnake: the game's box (40 by 26 cm) stood on its edge by the spiral
    # climb, the lid's green snake, its drawn ladders and its yellow title
    # band to the road (+X); the set's other two pawns left beside it, at the
    # board's pawns' size and in the two colours the board's four lack (the
    # board keeps the game's dice).
    W, H, D = 7.4, 4.8, 1.0
    box((D, H, W), (0, H / 2, 0), 0x5a8fd8)
    plate_x(D / 2 + 0.01, H - 1.35, H - 0.4, -W / 2 + 0.5, W / 2 - 0.5, 0xf2c14e)        # the title band
    tube([(D / 2 + 0.08, 0.65, -2.9), (D / 2 + 0.08, 1.7, -1.3), (D / 2 + 0.08, 0.95, 0.25),
          (D / 2 + 0.08, 2.3, 1.55), (D / 2 + 0.08, 2.85, 2.7)], 0.16, 0x6cbf6c, res=3, bevel_res=0)
    box((0.16, 0.42, 0.58), (D / 2 + 0.08, 2.95, 2.95), 0x6cbf6c)                    # its head
    for z in (-0.65, 1.3):                                                         # the drawn ladders
        for s in (-1, 1):
            plate_x(D / 2 + 0.02, 0.5, 2.75, z + s * 0.37 - 0.07, z + s * 0.37 + 0.07, 0xb06041)
        for y in (0.95, 1.5, 2.05, 2.6):
            plate_x(D / 2 + 0.02, y - 0.05, y + 0.05, z - 0.37, z + 0.37, 0xb06041)
    pawn((1.8, 0, -1.4), 0xfdf4de, k=0.4)
    pawn((2.5, 0, -0.4), 0x6cbf6c, k=0.4)
    merge_paint()

def floor_quad(pts, y, color):
    """A flat print at height `y` through [(x, z)], wound to face UP: the
    renderer takes a `floor` part's normals from its winding."""
    s = sum(pts[i][1] * pts[(i + 1) % len(pts)][0] - pts[i][0] * pts[(i + 1) % len(pts)][1] for i in range(len(pts)))
    if s < 0:
        pts = pts[::-1]
    o = quad([(x, y, z) for x, z in pts], color)
    o.name = 'floorq'                   # not merge_paint's: the mat joins as one `floor` part
    return o

@piece(1.0)
def floor_mat():
    # Skysnake's game again, as a floor mat the grid straight runs down the
    # middle of (placed at lat 0): a 1.8 m snakes-and-ladders mat of 144
    # squares lying flat on the boards, its printed snakes and ladders either
    # side of the road, three big floor-game pawns and two foam dice stood on
    # it. The mat is ONE `floor` part: the renderer lays it in the structures'
    # receiver so the deck's shadow falls on it, and spotIssue lets a print
    # that low pass under the deck.
    N, C = 12, 2.7
    B = N * C / 2
    Y0, Y1, Y2 = 0.03, 0.05, 0.065
    mat = [floor_quad([(-B - 0.4, -B - 0.4), (B + 0.4, -B - 0.4), (B + 0.4, B + 0.4), (-B - 0.4, B + 0.4)], Y0, 0x5a8fd8)]
    for i in range(N):
        for j in range(N):
            x0, z0 = -B + i * C, -B + j * C
            col = TOY[(i // 2 + j) % 4] if (i + j) % 2 == 0 else 0xfdf4de
            mat.append(floor_quad([(x0, z0), (x0 + C, z0), (x0 + C, z0 + C), (x0, z0 + C)], Y1, col))
    def band(pts, w, color, y):
        for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
            l = math.hypot(x1 - x0, z1 - z0) or 1.0
            nx, nz = -(z1 - z0) / l * w / 2, (x1 - x0) / l * w / 2
            mat.append(floor_quad([(x0 - nx, z0 - nz), (x1 - nx, z1 - nz), (x1 + nx, z1 + nz), (x0 + nx, z0 + nz)], y, color))
    def ladder(a, b, w):
        l = math.hypot(b[0] - a[0], b[1] - a[1])
        nx, nz = -(b[1] - a[1]) / l * w / 2, (b[0] - a[0]) / l * w / 2
        for s in (-1, 1):
            band([(a[0] + s * nx, a[1] + s * nz), (b[0] + s * nx, b[1] + s * nz)], 0.32, 0xb06041, Y2)
        for k in range(1, max(2, int(l / 1.0))):
            f = k / max(2, int(l / 1.0))
            cx, cz = a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
            band([(cx - nx, cz - nz), (cx + nx, cz + nz)], 0.24, 0xb06041, Y2 + 0.005)
    # the printed ladders and snakes, clear of the road down the middle (|x| < 3.5)
    for a, b in (((6.0, -13.0), (8.5, 1.0)), ((-11.5, -11.0), (-9.0, 4.0)), ((12.5, 3.0), (13.5, 14.0)),
                 ((-6.5, 6.0), (-5.0, 15.0)), ((14.0, -14.0), (15.0, -4.0))):
        ladder(a, b, 1.8)
    for ctrl, c in (([(-6.0, -4.0), (-8.5, -6.5), (-5.5, -9.0), (-8.0, -11.5), (-6.0, -14.5)], 0x6cbf6c),
                    ([(12.0, -1.0), (9.5, -4.5), (12.0, -8.0), (10.0, -12.0)], 0xe66a5a),
                    ([(-13.5, 15.0), (-10.5, 12.0), (-13.5, 9.0), (-11.5, 5.5)], 0xa878e8),
                    ([(5.0, 15.0), (8.0, 12.0), (5.0, 8.5), (7.0, 4.5)], 0x6cbf6c),
                    ([(16.0, 15.0), (14.5, 11.0), (16.5, 7.0)], 0xa878e8)):
        pts = curve(ctrl, 0.6)
        band(pts, 1.4, c, Y2 + 0.01)
        hx, hz = ctrl[0]
        mat.append(floor_quad([(hx - 0.8, hz), (hx, hz - 0.7), (hx + 0.8, hz), (hx, hz + 1.0)], Y2 + 0.015, c))
    group(mat, 'floor_mat')
    # the floor game's big pawns and its foam die, stood on the mat
    pawn((-7.0, Y1, -1.5), 0xe66a5a, k=0.9)
    pawn((6.5, Y1, 7.0), 0x5a8fd8, k=0.9)
    pawn((10.5, Y1, -9.0), 0xf2c14e, k=0.9)
    # foam dice in the toy colours, a little over a car's height: a cream
    # one this big, its pips in rows, read as a house with windows
    die((6.0, Y1, -5.0), 0.85, 0.5, color=0xe66a5a, pip=0xfdf4de)
    die((-8.0, Y1, 10.5), 0.85, -0.4, faces=(('+x', 1), ('-z', 6), ('+z', 3), ('-x', 4)), color=0x5a8fd8, pip=0xfdf4de)
    keep_light(0.2)
    merge_paint()

# ---- Skyline: a town of wooden blocks ---------------------------------------

WOOD = 0xf2bf99

def toy_wheel(x, z, r, w, along_x, color=0x2a2735):
    """A toy vehicle's wheel standing on the floor at (x, z), round, `w`
    thick, its axle across the vehicle (a vehicle `along_x` runs along X)."""
    if along_x:
        cyl(r, w, (x, r, z - w / 2), color, segs=12, axis='along', smooth=True)    # a smooth tread: rounder, and fewer vertices
    else:
        cyl(r, w, (x - w / 2, r, z), color, segs=12, axis='across', smooth=True)

def mini_car(x, z, color, along_x=False):
    """A toy car the racers' own size (0.9 long), standing on the rug."""
    def P2(a, b):                                   # (across, along) offsets in the car's frame
        return (x + b, z + a) if along_x else (x + a, z + b)
    for (a, b), (w, h, l), y, c in (((0, 0), (0.5, 0.2, 0.9), 0.24, color), ((0, -0.05), (0.44, 0.18, 0.45), 0.43, color),
                                     ((0, 0.19), (0.4, 0.14, 0.05), 0.43, 0x8ecae6)):
        px, pz = P2(a, b)
        box((l, h, w) if along_x else (w, h, l), (px, y, pz), c)
    for sa in (-1, 1):
        for sb in (-1, 1):
            px, pz = P2(sa * 0.25, sb * 0.3)
            toy_wheel(px, pz, 0.13, 0.1, along_x)

def house(x, z, w, d, h, body, roof, kind='gable'):
    """A wooden toy house: a painted block, a door and windows to the road
    (+X), a gable roof block (running along X), a flat roof slab or a
    pyramid on top."""
    box((w, h, d), (x, h / 2, z), body)
    plate_x(x + w / 2 + 0.01, 0, min(0.75, h * 0.45), z - 0.22, z + 0.22, 0x3a2a22)
    if h > 1.3:
        for s in (-1, 1):
            plate_x(x + w / 2 + 0.01, h - 0.75, h - 0.35, z + s * d * 0.28 - 0.18, z + s * d * 0.28 + 0.18, 0x8ecae6)
    if kind == 'gable':
        rh = min(w, d) * 0.55
        prism([(z - d / 2 - 0.15, h), (z + d / 2 + 0.15, h), (z, h + rh)], x, w + 0.2, roof)
    elif kind == 'flat':
        box((w + 0.2, 0.3, d + 0.2), (x, h + 0.15, z), roof)
    else:
        cyl(min(w, d) * 0.72, min(w, d) * 0.8, (x, h, z), roof, r2=0.05, segs=4, yaw=math.pi / 4)

def stack_tower(x, z, sizes, colors, cap):
    """A child's tower of stacked blocks, each turned a little, a cone on top."""
    y = 0.0
    for k, s in enumerate(sizes):
        box((s, s, s), (x, y + s / 2, z), colors[k % len(colors)], yaw=0.18 * ((k * 7) % 5 - 2))
        y += s
    cyl(sizes[-1] * 0.55, sizes[-1] * 1.1, (x, y, z), cap, r2=0.05, segs=8)
    return y

def toy_crane(CX, CZ, CH, G, tag='', p=12, turn=0.0):
    """A toy tower crane on the floor at (CX, CZ), its mast CH tall on a rug
    G thick: the jib, toward -Z at rest turned `turn` (box()'s sense),
    slews +-45 degrees every `p` s, and the block on its hook swings under
    the jib's tip, riding it."""
    box((1.8, 0.4, 1.8), (CX, G + 0.2, CZ), 0x555b66)
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((0.2, CH, 0.2), (CX + sx * 0.32, G + CH / 2, CZ + sz * 0.32), 0xf2c14e)
    for k in range(int((CH - 1.2) / 1.3) + 1):
        box((0.84, 0.14, 0.84), (CX, G + 1.2 + k * 1.3, CZ), 0xf2c14e)
    hx, hz = turned(CX, CZ, turn, 0.0, -4.2)                                      # the hook, under the jib's tip
    with animated('anim_sway:a=y:d=45:p=%g%s' % (p, tag), (CX, G + CH, CZ), yaw=turn):
        with transformed((CX, 0, CZ), turn):
            box((1.0, 0.9, 1.0), (CX, G + CH + 0.45, CZ), 0xff5040)               # the cab
            box((0.45, 0.4, 5.4), (CX, G + CH + 1.05, CZ - 1.9), 0xf2c14e)        # the jib
            box((0.9, 0.7, 1.0), (CX, G + CH + 0.8, CZ + 1.3), 0x555b66)          # the counterweight
        with animated('anim_sway:a=z:d=7:p=2.6%s' % tag, (hx, G + CH + 0.85, hz), yaw=turn):
            with transformed((CX, 0, CZ), turn):
                bar((CX, G + CH + 0.85, CZ - 4.2), (CX, G + CH - 2.0, CZ - 4.2), 0.06, 0.06, 0x2a2735)
                box((0.7, 0.7, 0.7), (CX, G + CH - 2.4, CZ - 4.2), 0x5a8fd8)       # a block on the hook

@piece(1.0)
def block_city():
    # Skyline: a town of wooden toy blocks built on a city play rug (printed
    # streets, a park, a building site), the racers' own size: houses with
    # gable roofs a block or two tall, a row of shops, a tower a child stacked
    # up to the skyway's height, toy cars parked in the streets, one driving
    # round the park block (anim_path, facing its way), and a toy crane
    # slewing over the building site. The rug is 1.3 by 1.65 m; its front
    # (+X) faces the road, the main street running along it (Z).
    RW, RL = 24.0, 30.0
    box((RW + 0.8, 0.08, RL + 0.8), (0, 0.04, 0), 0x5a8fd8)                     # the rug's border
    box((RW, 0.06, RL), (0, 0.11, 0), 0xfdf4de)                                 # the printed mat
    Y = 0.15
    def street(x0, z0, x1, z1):
        quad([(x0, Y, z0), (x1, Y, z0), (x1, Y, z1), (x0, Y, z1)], 0x868ba1)
    street(0.7, -RL / 2, 3.3, RL / 2)                                             # the main street
    for zc in (-6.0, 7.0):                                                        # and two cross streets
        street(-RW / 2, zc - 1.3, RW / 2, zc + 1.3)
    WX = -11.35                                                                   # a lane down the far edge
    street(-RW / 2, -7.3, -10.7, 8.3)
    for k in range(9):                                                            # dashes down the middle
        z = -RL / 2 + 1.6 + k * 3.4
        quad([(1.9, Y + 0.01, z), (2.1, Y + 0.01, z), (2.1, Y + 0.01, z + 1.2), (1.9, Y + 0.01, z + 1.2)], 0xfdf4de)
    quad([(-10.7, Y, -4.2), (-1.0, Y, -4.2), (-1.0, Y, 5.2), (-10.7, Y, 5.2)], 0x6cbf6c)    # the park
    quad([(-11.5, Y, 9.0), (-3.5, Y, 9.0), (-3.5, Y, 14.5), (-11.5, Y, 14.5)], WOOD)         # the building site
    G = 0.14                                                                      # the rug's top
    B = [  # (x, z, w, d, h, body, roof, kind), the road side first
        (5.0, -12.7, 2.2, 2.0, 1.8, 0xfdf4de, 0xe66a5a, 'gable'), (8.9, -12.6, 2.6, 2.4, 3.4, 0x8ecae6, 0xf2c14e, 'flat'),
        (5.0, -9.3, 2.0, 1.8, 1.4, 0xf2c14e, 0x5a8fd8, 'gable'), (9.4, -9.2, 2.2, 2.0, 1.6, WOOD, 0x6cbf6c, 'pyramid'),
        (5.2, -2.6, 2.4, 2.0, 2.0, WOOD, 0xe66a5a, 'gable'), (5.2, 0.9, 2.0, 2.0, 1.6, 0xfdf4de, 0x6cbf6c, 'gable'),
        (5.2, 4.1, 2.2, 1.8, 2.4, 0xe66a5a, 0xfdf4de, 'flat'), (9.6, -1.6, 3.0, 3.0, 4.6, 0xfdf4de, 0x5a8fd8, 'flat'),
        (9.6, 3.4, 2.4, 2.6, 2.2, 0x8ecae6, 0xe66a5a, 'gable'),
        (5.3, 10.4, 2.2, 2.0, 1.8, 0xf2c14e, 0xe66a5a, 'gable'), (9.4, 10.6, 2.4, 2.4, 2.6, WOOD, 0xa878e8, 'pyramid'),
        (5.5, 13.5, 2.0, 1.8, 1.5, 0xfdf4de, 0x5a8fd8, 'gable'), (9.4, 13.8, 2.4, 2.0, 2.8, 0xe66a5a, 0xf2c14e, 'flat'),
        (-2.4, -12.6, 3.0, 2.6, 5.0, 0xfdf4de, 0xe66a5a, 'flat'), (-6.6, -12.4, 2.4, 2.2, 2.0, WOOD, 0x6cbf6c, 'gable'),
        (-10.0, -12.6, 2.0, 2.0, 1.6, 0xf2c14e, 0xe66a5a, 'gable'), (-3.0, -9.1, 2.2, 1.8, 1.6, 0x8ecae6, 0xa878e8, 'gable'),
        (-8.4, -9.0, 2.6, 2.0, 2.4, 0xe66a5a, 0xfdf4de, 'flat'), (-1.6, 12.6, 2.2, 2.0, 1.8, 0xfdf4de, 0x5a8fd8, 'gable'),
    ]
    for x, z, w, d, h, body, roof, kind in B:
        o0 = set(bpy.context.scene.objects)
        house(x, z, w, d, h, body, roof, kind)
        for o in set(bpy.context.scene.objects) - o0:
            o.location.z += G                                                     # Blender Z is up
    for x, z in ((-9.6, -2.4), (-7.4, 3.6), (-4.0, 4.0), (-3.0, -2.8), (-6.2, -0.6)):   # wooden park trees
        cyl(0.14, 0.7, (x, G, z), 0x9a7b55, segs=6)
        cyl(0.6, 1.5, (x, G + 0.6, z), 0x6cbf6c, r2=0.05, segs=8)
    # the tower a child stacked by the park, up to the skyway
    stack_tower(-9.6, 1.4, (1.3, 1.25, 1.2, 1.15, 1.1, 1.05, 1.0), (0xe66a5a, WOOD, 0x5a8fd8, 0xf2c14e, 0x6cbf6c, 0xfdf4de), 0xff5040)
    # an arch of blocks over the main street
    for s in (-1, 1):
        box((0.7, 1.7, 0.7), (2.0 + s * 1.65, G + 0.85, -4.0), 0xa878e8)
    box((4.1, 0.6, 0.8), (2.0, G + 2.0, -4.0), 0xf2c14e)
    # the building site: loose blocks, and the toy crane lifting one
    for k, (x, z, s, c) in enumerate(((-10.2, 10.0, 0.9, 0xe66a5a), (-9.1, 10.2, 0.9, WOOD), (-9.7, 10.1, 0.9, 0x5a8fd8),
                                      (-10.4, 11.4, 0.8, 0xf2c14e), (-8.0, 13.6, 1.0, 0x6cbf6c))):
        box((s, s, s), (x, G + s / 2 + (0.9 if k == 2 else 0), z), c, yaw=0.3 * k)
    # The crane slews to and fro over the site's edge and the cross street
    # (its jib toward the town at rest, so the load never swings off the
    # rug), as a crane works, and the block on its hook swings (a pendulum
    # about the jib's own line, riding the jib).
    toy_crane(-6.0, 11.8, 5.6, G)
    for x, z, c, ax in ((2.6, -10.5, 0xff5040, False), (1.4, 9.0, 0x6cbf6c, False)):
        o0 = set(bpy.context.scene.objects)
        mini_car(x, z, c, along_x=ax)
        for o in set(bpy.context.scene.objects) - o0:
            o.location.z += G
    # the blue car drives round the park block: east along the south cross
    # street, up the main street, west along the north one, down the lane,
    # its corners rounded; built at the loop's first point, heading +X
    loop, RC = [], 1.2
    for (ax, az), (bx, bz) in (((WX, -6.0), (2.0, -6.0)), ((2.0, -6.0), (2.0, 7.0)),
                               ((2.0, 7.0), (WX, 7.0)), ((WX, 7.0), (WX, -6.0))):
        l = math.hypot(bx - ax, bz - az)
        dx, dz = (bx - ax) / l, (bz - az) / l
        n = int((l - 2 * RC) / 0.5)
        loop += [(ax + dx * (RC + (l - 2 * RC) * i / n), az + dz * (RC + (l - 2 * RC) * i / n)) for i in range(n)]
        nx, nz = -dz, dx                                                          # the turn is to the left
        cx, cz = bx - dx * RC + nx * RC, bz - dz * RC + nz * RC
        for i in range(6):
            a = math.pi / 2 * i / 6
            loop.append((cx - nx * RC * math.cos(a) + dx * RC * math.sin(a), cz - nz * RC * math.cos(a) + dz * RC * math.sin(a)))
    for i, (x, z) in enumerate(loop):
        marker('path_drive_%d' % i, (x, G, z))
    with animated('anim_path:c=drive:p=30:f=1', (loop[0][0], G, loop[0][1])):
        o0 = set(bpy.context.scene.objects)
        mini_car(loop[0][0], loop[0][1], 0x5a8fd8, along_x=True)
        for o in set(bpy.context.scene.objects) - o0:
            o.location.z += G
    merge_paint()
    keep_light(0.3)

@piece(1.0)
def block_towers():
    # Skyline: towers a child built of wooden blocks beside the skyway, up to
    # its deck (a 50 cm stack), a shorter one with an arch through it and
    # the blocks left over on the floor.
    stack_tower(0.0, 0.0, (1.4, 1.35, 1.3, 1.25, 1.2, 1.15, 1.1, 1.05), (0x5a8fd8, WOOD, 0xe66a5a, 0xf2c14e, 0x6cbf6c, 0xfdf4de), 0xf2c14e)
    stack_tower(-0.6, 3.2, (1.3, 1.2, 1.1, 1.0), (WOOD, 0xa878e8, 0xf2c14e), 0x5a8fd8)
    for s in (-1, 1):                                                             # the arch
        box((0.7, 1.6, 0.7), (-0.4, 0.8, -3.0 + s * 1.2), 0xe66a5a)
    box((0.9, 0.55, 3.2), (-0.4, 1.88, -3.0), 0xfdf4de)
    box((0.7, 0.7, 0.7), (-0.4, 2.5, -3.0), 0x6cbf6c, yaw=0.4)
    for k, (x, z, s, c) in enumerate(((1.6, 1.4, 1.0, 0xf2c14e), (1.9, -1.2, 0.9, WOOD), (1.2, 5.0, 0.9, 0xe66a5a))):
        box((s, s, s), (x, s / 2, z), c, yaw=0.5 * k + 0.2)

def helix_pts(cx, cz, R, y0, y1, a0, turns, per=16):
    n = int(turns * per)
    return [(cx + R * math.cos(a0 + 2 * math.pi * turns * i / n), y0 + (y1 - y0) * i / n,
             cz + R * math.sin(a0 + 2 * math.pi * turns * i / n)) for i in range(n + 1)]

def chute(pts, color, mr, half=0.75, wall=0.55, inner=None, t=0.08):
    """A marble run's chute: a U channel under the marbles (radius `mr`),
    swept along their line [(x, y, z)], a closed solid with walls `t` thick
    (piece units): the channel, its outside, a lip along each top edge and a
    cap at each end, each its own vertices so it keeps its own light. The kit
    draws both sides of every face, lit per vertex, so two shells on one
    surface fight in the depth buffer: no face here lies on another. `inner`
    paints the channel's floor its own colour (a separate part): from above,
    two coloured rims and a pale floor read as a channel where one colour
    reads as a plank."""
    n = len(pts)
    ins, outs, axis = [], [], []
    for i, p in enumerate(pts):
        a, b = pts[min(i + 1, n - 1)], pts[max(i - 1, 0)]
        tx, tz = a[0] - b[0], a[2] - b[2]
        l = math.hypot(tx, tz) or 1.0
        nx, nz = -tz / l, tx / l
        y = p[1] - mr - 0.05
        for ring, h, lo in ((ins, half, y), (outs, half + t, y - t)):
            ring.append([(p[0] + nx * h, y + wall, p[2] + nz * h), (p[0] + nx * h, lo, p[2] + nz * h),
                         (p[0] - nx * h, lo, p[2] - nz * h), (p[0] - nx * h, y + wall, p[2] - nz * h)])
        axis.append((p[0], y + wall / 2, p[2]))
    def strip(rings, ks):
        """Quads along the sweep over the profile's edges `ks`, sharing the
        profile's vertices between them (smooth round the U's corners)."""
        vs = [v for r in rings for v in r]
        return vs, [(4 * i + k, 4 * (i + 1) + k, 4 * (i + 1) + k + 1, 4 * i + k + 1) for i in range(n - 1) for k in ks]
    def orient(vs, faces, toward):
        """Wind every face so its normal points along toward(centre, i)."""
        out = []
        for f in faces:
            q = [vs[j] for j in f]
            c = [sum(v[j] for v in q) / len(q) for j in range(3)]
            nrm = [0.0, 0.0, 0.0]
            for j in range(len(q)):                  # Newell's normal
                u, w = q[j], q[(j + 1) % len(q)]
                nrm[0] += (u[1] - w[1]) * (u[2] + w[2])
                nrm[1] += (u[2] - w[2]) * (u[0] + w[0])
                nrm[2] += (u[0] - w[0]) * (u[1] + w[1])
            d = toward(c, f[0] // 4)
            out.append(f if sum(nrm[j] * d[j] for j in range(3)) >= 0 else tuple(reversed(f)))
        return out
    def mid(i):                                      # the channel's middle between sections i and i + 1
        a, b = axis[min(i, n - 1)], axis[min(i + 1, n - 1)]
        return [(a[j] + b[j]) / 2 for j in range(3)]
    def into(c, i):                                  # into the channel: toward its middle
        return [mid(i)[j] - c[j] for j in range(3)]
    def away(c, i):
        return [c[j] - mid(i)[j] for j in range(3)]
    groups = {color: ([], [])}                       # a colour's surfaces, each on its own vertices, one part
    def add(c, vs, faces):
        gv, gf = groups.setdefault(c, ([], []))
        gf += [tuple(len(gv) + j for j in f) for f in faces]
        gv += vs
    if inner is not None:                            # the channel's floor (profile edge 1), and its walls
        vs, fs = strip(ins, (1,))
        add(inner, vs, orient(vs, fs, into))
        vs, fs = strip(ins, (0, 2))
        add(color, vs, orient(vs, fs, into))
    else:
        vs, fs = strip(ins, (0, 1, 2))
        add(color, vs, orient(vs, fs, into))
    vs, fs = strip(outs, (0, 1, 2))
    add(color, vs, orient(vs, fs, away))
    lips = [[ins[i][k], outs[i][k]] for i in range(n) for k in (0, 3)]
    vs = [v for pair in lips for v in pair]          # 4 vertices a section: in0, out0, in3, out3
    fs = [(4 * i + o, 4 * (i + 1) + o, 4 * (i + 1) + o + 1, 4 * i + o + 1) for i in range(n - 1) for o in (0, 2)]
    add(color, vs, orient(vs, fs, lambda c, i: (0.0, 1.0, 0.0)))
    for i, sgn in ((0, -1), (n - 1, 1)):             # the end caps: three quads tile the U's section
        a, b = pts[min(i + 1, n - 1)], pts[max(i - 1, 0)]
        d = (sgn * (a[0] - b[0]), sgn * (a[1] - b[1]), sgn * (a[2] - b[2]))
        vs = ins[i] + outs[i]
        add(color, vs, orient(vs, [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6)], lambda c, _i: d))
    for c, (vs, faces) in groups.items():
        me = bpy.data.meshes.new('chute')
        me.from_pydata([tuple(P(*v)) for v in vs], [], faces)
        for f in me.polygons:
            f.use_smooth = True
        me.update()
        o = bpy.data.objects.new('chute', me)
        bpy.context.scene.collection.objects.link(o)
        paint(o, c)

@piece(0.65)
def marble_tower():
    # Helix: one more tower of the marble run's kit (about 45 cm), stood
    # where the grid straight points: a column of the same stacked toy
    # cylinders with a chute wound round it in a helix, three marbles
    # rolling down it, into the column's foot and up inside it (out of sight)
    # to the cup on top. Beside it the slinky walks down off its block, a helix
    # of its own: the two read as one corner of the room where a slinky
    # alone was a speck. Side by side along X, read from +Z (the slinky's
    # arch faces it).
    slinky()
    K = 0.62 / 0.65                              # the marble run's own size, in this piece's units
    TX = 9.6                                     # the tower's axis, past the slinky's floor stack
    R, MR, TURNS = 3.0 * K, 0.62 * K, 3.25
    LOW, HIGH = MR + 0.07 * K, 13.4 * K
    cyl(2.2 * K, 0.4 * K, (TX, 0, 0), 0x9aa1b4, segs=12)
    h = HIGH + 0.3 * K
    n = 5
    for k in range(n):
        cyl(1.25 * K, h / n, (TX, 0.4 * K + k * h / n, 0), TOY[(k + 2) % 4], segs=10)
    top = 0.4 * K + h
    cyl(1.0 * K, 1.1 * K, (TX, top, 0), 0xfdf4de, r2=2.0 * K, segs=10)        # the cup the marbles come up into
    down = helix_pts(TX, 0, R, HIGH, LOW, 0.0, TURNS)
    chute(down, 0x6cbf6c, MR, half=0.75 * K, wall=0.55 * K, t=0.06 / 0.65)
    foot = (TX + 0.6 * K * math.cos(2 * math.pi * TURNS), LOW, 0.6 * K * math.sin(2 * math.pi * TURNS))
    chute([down[-1], foot], 0xf2c14e, MR, half=0.75 * K, wall=0.55 * K, t=0.06 / 0.65)   # into the column's foot
    box((1.9 * K, 1.5 * K, 0.4 * K), (foot[0], LOW + 0.1 * K, foot[2] + 0.62 * K), 0x2a2735)   # its doorway
    for i in range(4, len(down) - 1, 8):                                         # spokes from the column
        p = down[i]
        dx, dz = p[0] - TX, p[2]
        l = math.hypot(dx, dz)
        bar((TX + dx / l * 1.2 * K, p[1] - MR - 0.1 * K, dz / l * 1.2 * K),
            (p[0] - dx / l * 0.7 * K, p[1] - MR - 0.1 * K, p[2] - dz / l * 0.7 * K), 0.3 * K, 0.3 * K, 0x9aa1b4)
    # the loop: down the screw, into the foot, up the column's middle, out
    # of the cup and back to the top of the screw
    loop = down + [foot] + [(TX, LOW + (top - LOW) * j / 6, 0) for j in range(7)] + [(TX, top + 0.5 * K, 0)]
    for k, p in enumerate(loop):
        marker('path_tower_%d' % k, p)
    for m, c in enumerate((0xe66a5a, 0x5a8fd8, 0xf2c14e)):
        at = down[int(len(down) * m / 3)]
        with animated('anim_path:c=tower:p=11:o=%.4f:f=0#%d' % (m / 3, m), at):
            sphere(MR, at, c, subdiv=2, flat=False)

# ---- Helix: the great marble run ---------------------------------------------------
# ONE marble run round the whole room in the race's direction, built in WORLD
# coordinates from the shipped centreline and cut into sections, one GLB each,
# placed with yaw = -heading so a section's frame is the world's (its origin is
# RUN_ORIGIN[name], where tracks.js places it). Joints between sections share
# their coordinates: one section's marbles drop into a cup on a fat post and
# the next one's come up out of it, so the hand-over is never seen. A marble
# only rolls DOWN in sight except at the three lifts, each a different
# machine: the marble tower's own column (hidden), the summit screw and the
# stair lift. Its order: the tower's cup (set-marble-tower, untouched) ->
# over the corner after the grid straight -> along the top leg's infield
# through a marble wheel -> a catch tray -> the summit screw lift -> over the
# skyway -> south along its outside, down a stair of tone bars -> a vortex
# bowl and a helix -> along the south leg's outside, round a loop beside the
# mid leg -> on the floor to the stair lift -> the marble racer beside the
# grid straight -> back into the tower's foot. Striped stacked cylinders are
# only its stations, each a different height; trestles are plain grey
# connector posts with collars.

RUN_MR, RUN_HALF, RUN_WALL = 0.38, 0.55, 0.26     # a marble (a car's wheel), a chute's half width and wall (low: most of a marble shows over it)
RUN_SPEED, RUN_GAP = 3.5, 5.0                    # every section's marbles: u/s, and the gap between them
RUN_UNDER = -1.5                                 # the way back, under the floor
GREY, CREAM, COLLAR = 0x9aa1b4, 0xfdf4de, 0x868ba1
RUN_MARBLES = (0xe66a5a, 0x5a8fd8, 0xf2c14e, 0x6cbf6c, 0xa878e8, 0xff7e44)
RUN_COLORS = (0xe66a5a, 0xf2c14e, 0x5a8fd8, 0x6cbf6c)   # the conveyor's four, the racer's lanes' colours in their order
TOWER = (-1.66, 72.11)                           # set-marble-tower's column (u 0.1253 lat 14.5 yaw -45)
TOWER_RIM = (0.4 + 13.4 + 0.3 + 1.1) * 0.62      # its cup's rim over the floor (marble_tower at its grow)
RUN_D2 = (6.4, 5.4, 57.3)                        # the head's inner post, where the wheel's leg takes over
RUN_ORIGIN = {'head': (-7.0, 50.0), 'wheel': (25.0, 57.4), 'summit': (52.0, 57.4), 'skyway': (75.7, 30.0),
              'vortex': (75.7, 10.0), 'loop': (40.0, -21.4), 'stair': (15.0, -15.4), 'racer': (-7.0, 24.0)}

def fillet(pts, r=1.5, n=6):
    """A polyline of marble centres [(x, h, z)] with each corner rounded."""
    out = [pts[0]]
    for a, b, c in zip(pts, pts[1:], pts[2:]):
        d1, d2 = math.hypot(b[0] - a[0], b[2] - a[2]), math.hypot(c[0] - b[0], c[2] - b[2])
        t = min(r, 0.45 * d1, 0.45 * d2)
        p = [b[j] + (a[j] - b[j]) * t / d1 for j in range(3)]
        q = [b[j] + (c[j] - b[j]) * t / d2 for j in range(3)]
        out += [tuple((1 - s) ** 2 * p[j] + 2 * s * (1 - s) * b[j] + s * s * q[j] for j in range(3))
                for s in (k / n for k in range(n + 1))]
    return out + [pts[-1]]

def run_chute(pts, color):
    chute(pts, color, RUN_MR, half=RUN_HALF, wall=RUN_WALL, inner=CREAM)

def toward(a, b, d=0.55):
    """The point `d` from a toward b (a chute's end beside a joint's cup)."""
    l = math.dist(a, b)
    return tuple(a[j] + (b[j] - a[j]) * d / l for j in range(3))

def on(line, x, z):
    """The point of `line` nearest (x, z)."""
    return min(line, key=lambda p: math.hypot(p[0] - x, p[2] - z))

def trestle(p):
    """A plain grey connector post up to the chute whose marbles ride at p
    (x, h, z), a collar at its head; a tall one is fatter."""
    x, h, z = p
    top = h - RUN_MR - 0.05 - 0.06               # into the chute's wall, never on a face
    r = 0.16 if top < 3.5 else 0.27
    cyl(r + 0.16, 0.12, (x, 0, z), COLLAR, segs=8)
    cyl(r, top, (x, 0, z), GREY, segs=8)
    cyl(r + 0.14, 0.22, (x, top - 0.26, z), COLLAR, segs=8)   # under the post's top: level with it, the two caps flickered

def joint(x, z, h, toward=(), color=0x5a8fd8):
    """A STATION, where one section hands its marbles to the next: a closed
    drum under a cream lid on a fat connector post (a low one stands on the
    floor), the marbles' line through its middle at `h`, a dark mouth in its
    wall toward each of `toward` [(x, z)], where a chute or a pair of rails
    runs in. The hand-over happens inside it: one section's marble dives
    down the post as the next one's, the same marble on the run's conveyor
    (run_marbles), carries on out of the far mouth. Nothing appears or
    vanishes in sight."""
    lo = max(0.0, h - 0.8)
    if lo > 0.9:
        cyl(0.6, 0.12, (x, 0, z), COLLAR, segs=10)
        cyl(0.44, lo - 0.1, (x, 0, z), GREY, segs=10)
        cyl(0.54, 0.2, (x, lo - 0.35, z), COLLAR, segs=10)
    else:
        lo = 0.0
    cyl(0.95, h + 0.75 - lo, (x, lo, z), color, segs=12)
    cyl(1.08, 0.2, (x, h + 0.75, z), CREAM, segs=12)
    cyl(0.3, 0.22, (x, h + 0.95, z), color, segs=8)
    for tx, tz in toward:
        dx, dz = tx - x, tz - z
        l = math.hypot(dx, dz)
        box((1.3, 1.0, 0.3), (x + dx / l * 0.9, h + 0.07, z + dz / l * 0.9), 0x2a2735, yaw=math.atan2(dx, dz))

def mouth(at, toward, w=1.3, h=1.0):
    """A dark doorway on a housing's wall at `at` (x, y, z), facing `toward`
    (x, z): where a chute runs into a drum, a column or a box."""
    dx, dz = toward[0] - at[0], toward[1] - at[2]
    box((w, h, 0.3), at, 0x2a2735, yaw=math.atan2(dx, dz))

def run_station(x, z, top, c0, r=0.8):
    """One of the run's stations: the kit's stacked toy cylinders, a band to
    about each 1.6 u, up to a cream cap at `top`."""
    cyl(r + 0.5, 0.25, (x, 0, z), GREY, segs=12)
    n = max(2, round((top - 0.55) / 1.6))
    h = (top - 0.55) / n
    for k in range(n):
        cyl(r, h, (x, 0.25 + k * h, z), TOY[(k + c0) % 4], segs=10)
    cyl(r + 0.15, 0.3, (x, top - 0.3, z), CREAM, segs=10)

def rails(pts, color, out=None):
    """Twin rails the marbles ride on through the line `pts`, open so they
    show from below, on cream cross ties. `out(i)` is the rails' side of the
    line (default straight down)."""
    n = len(pts)
    left, right, ties = [], [], []
    for i, p in enumerate(pts):
        a, b = pts[min(i + 1, n - 1)], pts[max(i - 1, 0)]
        t = [a[j] - b[j] for j in range(3)]
        d = out(i) if out else (0.0, -1.0, 0.0)
        s = (t[1] * d[2] - t[2] * d[1], t[2] * d[0] - t[0] * d[2], t[0] * d[1] - t[1] * d[0])   # across: t x d
        l = math.sqrt(sum(v * v for v in s)) or 1.0
        s = [v / l for v in s]
        left.append(tuple(p[j] + 0.38 * d[j] + 0.26 * s[j] for j in range(3)))
        right.append(tuple(p[j] + 0.38 * d[j] - 0.26 * s[j] for j in range(3)))
        ties.append((tuple(p[j] + 0.46 * d[j] + 0.4 * s[j] for j in range(3)), tuple(p[j] + 0.46 * d[j] - 0.4 * s[j] for j in range(3))))
    tube(left, 0.1, color, res=2, bevel_res=0)
    tube(right, 0.1, color, res=2, bevel_res=0)
    run = 0.0
    for i in range(1, n):
        run += math.dist(pts[i], pts[i - 1])
        if run >= 0.9 or i == n - 1:
            bar(*ties[i], 0.16, 0.12, CREAM)
            run = 0.0

def resample(pts, step=0.6):
    """The line through `pts` with a point about every `step`."""
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        k = max(1, math.ceil(math.dist(a, b) / step))
        out += [tuple(a[j] + (b[j] - a[j]) * i / k for j in range(3)) for i in range(1, k + 1)]
    return out

RUN_ARCS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'run_arcs.json')

def run_arc(chain, value=None):
    """Where chain `chain` ENDS on the run's conveyor (below), kept in
    run_arcs.json so one section baked alone still meets its neighbours;
    `value` records it."""
    arcs = json.load(open(RUN_ARCS)) if os.path.exists(RUN_ARCS) else {}
    if value is not None and abs(arcs.get(chain, 1e9) - value) > 1e-6:
        arcs[chain] = round(value, 6)
        with open(RUN_ARCS, 'w') as f:
            json.dump(arcs, f, indent=1, sort_keys=True)
            f.write('\n')
    return arcs[chain]

def run_marbles(chain, seen, lite, after=None, lane=None):
    """A section's marbles: along `seen` (their centres, from the station or
    housing they come out of to the one they go into), then down, back under
    the floor and up the first one, a loop at RUN_SPEED.

    THE RUN IS ONE CONVEYOR. Marble i of the whole run is RUN_GAP * i behind
    marble 0 along it and wears RUN_COLORS[i % 4], and a chain `after`
    another starts where that one ends, so at a station the marble diving
    out of sight and the one coming on are the same marble: same place, same
    moment, same colour. For that every loop is a whole number of colour
    cycles long (padded under the floor) and every chain runs at one speed.
    The lite build draws every third marble of the same conveyor. A `lane`
    (0-3) takes only its own colour's marbles: the racer's sorter."""
    mult = 3 if lite else 1
    s0 = run_arc(after) if after else 0.0
    vis = sum(math.dist(a, b) for a, b in zip(seen, seen[1:]))
    run_arc(chain, s0 + vis)
    (sx, _, sz), (ex, _, ez) = seen[0], seen[-1]
    cycle = 4 * mult * RUN_GAP
    raw = vis + (seen[-1][1] - RUN_UNDER) + math.hypot(ex - sx, ez - sz) + (seen[0][1] - RUN_UNDER)
    length = math.ceil(raw / cycle) * cycle
    deep = RUN_UNDER - (length - raw) / 2
    for k, q in enumerate(list(seen) + [(ex, deep, ez), (sx, deep, sz)]):
        marker('path_%s_%d' % (chain, k), q)
    first, step = (0, mult) if lane is None else ((9 * lane) % 12 if lite else lane, 4 * mult)
    for j in range(round(length / (step * RUN_GAP))):
        i = first + j * step
        with animated('anim_path:c=%s:p=%.4f:o=%.5f:f=0#%d' % (chain, length / RUN_SPEED, ((-s0 - i * RUN_GAP) / length) % 1.0, j), seen[1]):
            sphere(RUN_MR, seen[1], RUN_COLORS[i % 4], subdiv=1 if lite else 2, flat=False)
            bpy.ops.object.shade_smooth()

def run_section(name, lite):
    """Build section `name` in world coordinates, then move it to its origin."""
    RUN_BUILD[name](lite)
    ox, oz = RUN_ORIGIN[name]
    for o in bpy.context.scene.objects:
        if o.parent is None:
            o.location -= P(ox, 0, oz)
    ANIMS[:] = [(nm, (pv[0] - ox, pv[1], pv[2] - oz), yaw, parent, tilt) for nm, pv, yaw, parent, tilt in ANIMS]

def run_head(lite):
    # C -> D: out of the marble tower's cup, east to a post outside the
    # corner after the grid straight and across it on twin rails to a post
    # inside it: the run crossing the road in front of the cars, the tower
    # the straight points at its head. It FALLS 4 u on the way, a slope a
    # racer reads: the span comes toward the cars down the grid straight,
    # where anything overhead climbs the picture as it nears, and on a fall
    # of under a unit its marbles looked to roll uphill out of the tower.
    # The outer post stands east of the tower, never between it and the
    # straight.
    tx, tz = TOWER
    out = (tx, TOWER_RIM + 0.45, tz - 1.3)       # over the cup's rim
    D1, D2 = (3.6, 8.7, 69.4), RUN_D2
    line = fillet([out, D1, D2], r=1.3)
    run_chute(line[:-1], 0xe66a5a)               # the chute takes the bend, the rails the span
    span = resample([line[-2], toward(D2, line[-2], 0.6)])
    rails(span, 0xe66a5a)
    trestle(D1)
    joint(D2[0], D2[2], D2[1], toward=(line[-2][0::2], (9.6, 55.4)), color=0xe66a5a)
    run_marbles('head', [(tx, out[1], tz)] + line, lite)

def marble_wheel(cx, cy, cz, R):
    """A marble wheel turning slowly about z: two open paddle wheels on one
    drum, the marbles riding the drum down between them on the side the
    chute feeds, carried by the paddles. Rims, radial paddles and two plain
    upright posts: nothing hangs from the rim and nothing straddles it on
    legs (on an A-frame with boxes round its rim it read as a Ferris wheel)."""
    for s in (-1, 1):
        z = cz + s * 1.0
        cyl(0.32, 0.12, (cx, 0, z), COLLAR, segs=8)
        cyl(0.2, cy + 0.25, (cx, 0, z), GREY, segs=8)
        cyl(0.3, 0.2, (cx, cy - 0.1, z - 0.1), COLLAR, segs=8, axis='along')   # the bearing
    cyl(0.14, 2.3, (cx, cy, cz - 1.15), COLLAR, segs=8, axis='along')           # the axle
    with animated('anim_spin:a=z:w=-0.8#wheel', (cx, cy, cz)):
        cyl(0.77, 1.64, (cx, cy, cz - 0.82), 0xf2c14e, segs=16, axis='along')  # the drum the marbles ride on, past the paddles' faces (on its caps they fought)
        for s in (-1, 1):                         # each wheel: a broad rim, the paddles inside it
            zp, zr = cz + s * 0.59, cz + s * 0.8
            torus(R - 0.22, 0.2, (cx, cy, zr), 0x5a8fd8, segs=20, axis='along')
            for k in range(8):
                a = math.pi / 8 + k * math.pi / 4
                bar((cx + 0.4 * math.cos(a), cy + 0.4 * math.sin(a), zp), (cx + (R - 0.1) * math.cos(a), cy + (R - 0.1) * math.sin(a), zp),
                    0.38, 0.1, 0xe66a5a)

def run_wheel(lite):
    # E: from the corner's inner post east along the top leg's infield, about
    # 9 u in from the road, falling through a marble wheel, past the spinning
    # tops (behind them), turning away from the road to the catch tray.
    D2 = RUN_D2
    Z, WX, WY, R = 55.4, 27.0, 2.6, 1.6
    top = fillet([toward(D2, (9.6, D2[1] - 0.2, Z)), (9.6, D2[1] - 0.2, Z), (WX - 1.35, WY + 1.65, Z)], r=1.4)   # its end over the paddles' tips
    run_chute(top, 0xf2c14e)
    low = fillet([(WX + 0.35, WY - 1.9, Z), (40.0, 0.66, Z), LIFT_PORT], r=2.2)   # along the floor into the screw lift's foot
    run_chute(low, 0xf2c14e)
    marble_wheel(WX, WY, Z, R)
    for x in (13.5, 20.0):
        trestle(on(top, x, Z))
    lows = resample(low, 0.5)
    for f in (0.2, 0.4, 0.6, 0.8):                  # sleepers under the floor chute
        a, b = lows[int(len(lows) * f)], lows[int(len(lows) * f) + 1]
        box((1.0, 0.1, 0.3), (a[0], 0.05, a[2]), COLLAR, yaw=math.atan2(b[0] - a[0], b[2] - a[2]))
    ride = [(WX + 1.15 * math.cos(a), WY + 1.15 * math.sin(a), Z) for a in (math.pi * (0.5 - k / 8) for k in range(9))]
    run_marbles('wheel', [D2] + top + ride + low + [(LIFT[0], 0.6, LIFT[1])], lite, after='head')

LIFT = (52.8, 42.7)                              # the summit screw lift's axis
LIFT_PORT = (50.75, 0.6, 44.2)                   # where the floor chute meets its foot drum's wall

def screw_lift(cx, cz, H, RP, lite):
    """The summit lift: six posts of the kit's stacked cylinders round a
    turning yellow screw, cream hoops binding them, between two closed
    drums. The floor chute runs into the foot drum; the marbles come up out
    of it on the screw's flight (each keeps its side of the cage, the posts
    hold it there, and rides the flight up at the flight's own climb, a
    pitch a turn), into the head drum, and the chute beyond leaves that. So
    a marble is in sight on the chute, on the screw and on the next chute,
    and changes hands only inside a drum."""
    FOOT, HEAD = 1.3, H - 1.0                     # the foot drum's top, the head drum's underside
    cyl(RP + 0.45, FOOT, (cx, 0, cz), GREY, segs=16)
    cyl(1.55, 0.04, (cx, FOOT, cz), 0x2a2735, segs=16)                          # the well the screw comes up out of
    for k in range(6):
        a = math.pi / 6 + k * math.pi / 3
        x, z = cx + RP * math.cos(a), cz + RP * math.sin(a)
        n = 7
        for j in range(n):
            cyl(0.28, (H - FOOT) / n, (x, FOOT + j * (H - FOOT) / n, z), TOY[(j + k) % 4], segs=8)
    for y in (H * 0.4, H * 0.68):
        torus(RP, 0.13, (cx, y, cz), CREAM, segs=18)
    cyl(RP - 0.2, 1.6, (cx, HEAD, cz), 0xa878e8, segs=16)                       # the head drum
    cyl(RP + 0.1, 0.22, (cx, HEAD + 1.6, cz), CREAM, segs=16)
    cyl(0.4, 0.3, (cx, HEAD + 1.82, cz), 0xa878e8, segs=8)
    # `o=0` pins the screw's turn to the clock, so the flight is under every
    # marble: at a column's side A it stands at Y0 + C * (A + w t) and one
    # pitch on each turn above it.
    W, TURNS, Y0, Y1, RM = 2.0, 9, 0.6, H - 0.5, 1.05
    PITCH = (Y1 - Y0) / TURNS
    C = PITCH / (2 * math.pi)
    with animated('anim_spin:a=y:w=%.1f:o=0#screw' % W, (cx, 0, cz)):
        cyl(0.45, H - 0.3, (cx, 0.3, cz), 0x868ba1, segs=10)                     # the shaft (marbles come down inside it)
        tube(helix_pts(cx, cz, RM, Y0, Y1, 0.0, TURNS, per=12), 0.2, 0xf2c14e, res=1, bevel_res=0)
    N, UP = 24, 9                                  # the loop in pitches; of them the climb, drum to drum
    cols = (math.pi / 3,) if lite else (math.pi, math.pi / 3, -math.pi / 3)   # between the cage's posts
    for k, A in enumerate(cols):
        yb = Y0 + 0.52 + C * (A % (2 * math.pi)) - PITCH   # on the flight at t = 0, inside the foot drum
        x, z = cx + RM * math.cos(A), cz + RM * math.sin(A)
        yt = yb + UP * PITCH                       # inside the head drum
        deep = (N * PITCH - (yt - yb) - 2 * RM - (yt + yb)) / 2       # under the floor, so the loop is N pitches
        loop = [(x, yb, z), (x, yt, z), (cx, yt, cz), (cx, -deep, cz), (x, -deep, z)]
        for j, q in enumerate(loop):
            marker('path_lift%d_%d' % (k, j), q)
        step = 6 if lite else 3                    # a marble every so many turns of the flight
        for j in range(N // step):
            with animated('anim_path:c=lift%d:p=%.4f:o=%.5f:f=0#%d' % (k, N * 2 * math.pi / W, (j * step + k) / N, j), loop[1]):
                sphere(RUN_MR, loop[1], RUN_COLORS[(j + k) % 4], subdiv=1 if lite else 2, flat=False)
                bpy.ops.object.shade_smooth()
    return HEAD

def run_summit(lite):
    # F + G: the top leg's floor chute runs into the foot of the summit screw
    # lift outside the climb's middle, the tallest thing in the room; the
    # lift takes the marbles up into its head drum, and a chute leaves that
    # east on one trestle for the station by the skyway.
    LX, LZ = LIFT
    H = 11.0
    head = screw_lift(LX, LZ, H, 2.0, lite)
    px, py, pz = LIFT_PORT
    mouth((px, py + 0.1, pz), (40.0, 55.4))
    J = (63.7, 10.75, 42.25)
    y0 = head + 1.0                               # the marbles' line inside the head drum
    line = [(LX + 1.2, y0, LZ - 0.05), (58.5, 10.9, 42.5), (J[0] - 0.55, J[1] + 0.05, J[2])]
    run_chute(line, 0x6cbf6c)
    mouth((LX + 1.75, y0 + 0.07, LZ - 0.05), (58.5, 42.5))
    trestle(line[1])
    joint(J[0], J[2], J[1], toward=((58.5, 42.5), (75.2, J[2])), color=0x6cbf6c)
    run_marbles('summit', [(LX, y0, LZ)] + line + [J], lite)

def run_skyway(lite):
    # H + J: over the skyway on twin rails, about 5 u over its deck, to a
    # station outside it, then south along its outside a few units over the
    # racers' eyes, the marbles ticking down a stair of five tone bars, still
    # over their eyes at its foot (lower, the deck's kerb hides the run).
    LOW = 7.8                                     # the run's height at the vortex's post
    J0, X = (63.7, 10.75, 42.25), 75.2
    span = resample([(J0[0] + 0.5, 10.7, J0[2]), (X - 1.4, 10.45, J0[2])])
    rails(span, 0x5a8fd8)
    run_station(X, J0[2], 10.4 - RUN_MR - 0.09, 1)   # its cap inside the chute's floor over it
    bend = fillet([(X - 1.4, 10.45, J0[2]), (X, 10.4, J0[2]), (X, 10.25, J0[2] - 1.6), (X, LOW + 1.55, 20.6)], r=1.2)
    run_chute(bend, 0x5a8fd8)
    bars = []                                                                  # the stair: five tone bars, each a step down
    for k, c in enumerate((0xe66a5a, 0xff7e44, 0xf2c14e, 0x6cbf6c, 0x5a8fd8)):
        z0 = 20.3 - 0.5 * k
        y = LOW + 1.55 - RUN_MR - 0.05 - 0.26 * (k + 1)
        box((1.1, 0.14, 0.44), (X, y - 0.07, z0 - 0.22), c)
        bars += [(X, y + RUN_MR, z0), (X, y + RUN_MR, z0 - 0.44)]
    for s in (-1, 1):                                                          # the stair's two cheeks
        bar((X + s * 0.62, LOW + 1.2, 20.5), (X + s * 0.62, LOW - 0.1, 17.7), 0.12, 0.3, CREAM)
    end = (X, LOW, 9.0)
    tail = [(X, bars[-1][1] - 0.02, 17.5), (X, LOW + 0.05, end[2] + 0.55)]
    run_chute(tail, 0x5a8fd8)
    for z in (34.0, 27.0, 21.2):
        trestle(on(resample(bend, 0.3), X, z))    # resampled: the bend's long straight is one segment, and three posts stood at its ends
    for z in (17.0, 13.0):
        trestle(on(resample(tail, 0.3), X, z))
    joint(X, end[2], end[1], toward=((X, end[2] + 1.0), (X, end[2] - 1.0)), color=0xf2c14e)
    run_marbles('sky', [J0] + span + bend + bars + tail + [end], lite, after='summit')

def bowl(cx, cz, r0, y0, r1, y1, outside, inside, segs=20):
    """A vortex bowl: open, round, its floor curving from the hole (r0, at
    y0) up to the rim (r1, y1), a closed shell 0.1 thick so no face lies on
    another."""
    prof = [(r0 + (r1 - r0) * i / 6, y0 + (y1 - y0) * (i / 6) ** 1.7) for i in range(7)]
    def ring(r, y):
        return [(cx + r * math.cos(2 * math.pi * k / segs), y, cz + r * math.sin(2 * math.pi * k / segs)) for k in range(segs)]
    def mesh(rings, color, up):
        vs = [v for r in rings for v in r]
        fs = []
        for i in range(len(rings) - 1):
            for k in range(segs):
                f = (i * segs + k, i * segs + (k + 1) % segs, (i + 1) * segs + (k + 1) % segs, (i + 1) * segs + k)
                fs.append(f if up else tuple(reversed(f)))
        me = bpy.data.meshes.new('bowl')
        me.from_pydata([tuple(P(*v)) for v in vs], [], fs)
        for f in me.polygons:
            f.use_smooth = True
        me.update()
        o = bpy.data.objects.new('bowl', me)
        bpy.context.scene.collection.objects.link(o)
        if (o.data.polygons[0].normal.z < 0) == up:
            for f in o.data.polygons:
                f.flip()
        return paint(o, color)
    mesh([ring(r, y) for r, y in prof], inside, True)
    mesh([ring(r + 0.1, y - 0.1) for r, y in prof], outside, False)
    mesh([ring(r1, y1), ring(r1 + 0.1, y1)], CREAM, True)                     # the rim
    mesh([ring(r0 + 0.1, y0 - 0.1), ring(r0, y0)], outside, True)             # the hole's lip
    return prof

def run_vortex(lite):
    # K: on along the skyway's outside, over the racers' eyes, into a wide
    # bowl outside the spiral-down's first quarter, its rim a little over
    # their eyes where the skyway ends (at the deck's height the descent's
    # outer kerb hid it); the marbles circle down it, drop through it and its
    # column to a spout, and wind down a helix round a grey column to the
    # south leg's outside.
    X, J0 = 75.2, (75.2, 7.8, 9.0)
    BX, BZ, R0, Y0, R1, Y1 = 73.2, -8.4, 0.42, 6.1, 2.3, 7.1
    in_ = [(X, 7.75, J0[2] - 0.55), (X, 7.6, -6.3)]      # its end clear of the bowl's rim, the marbles over it
    run_chute(in_, 0xa878e8)
    trestle(on(resample(in_, 0.3), X, 1.0))
    run_station(BX, BZ, Y0 - 0.05, 2, r=0.55)         # its cap inside the bowl's shell
    bowl(BX, BZ, R0, Y0, R1, Y1, 0xa878e8, 0xf2c14e)
    def floor(r):
        f = (r - R0) / (R1 - R0)
        return Y0 + (Y1 - Y0) * max(0.0, f) ** 1.7
    spiral = []
    for i in range(41):                          # two turns from the rim's east side, inward
        f = i / 40
        a, r = -2 * math.pi * 2 * f, 2.0 - 1.55 * f
        spiral.append((BX + r * math.cos(a), floor(r) + RUN_MR + 0.04, BZ + r * math.sin(a)))
    HX, HZ, HR = 72.4, -13.6, 1.6
    a0 = math.radians(81)
    turns, top, n = 2.475, Y0 - 0.4, 60          # it ends heading west, onto the south run
    helix = [(HX + HR * math.cos(a0 - 2 * math.pi * turns * i / n), top - (top - 2.45) * i / n, HZ + HR * math.sin(a0 - 2 * math.pi * turns * i / n))
             for i in range(n + 1)]
    spout = [(BX - 0.08, Y0 - 0.2, BZ - 0.6), helix[0]]
    run_chute(spout, 0xa878e8)
    run_chute(helix, 0xe66a5a)
    cyl(0.6, 0.12, (HX, 0, HZ), COLLAR, segs=10)
    cyl(0.4, top - 0.1, (HX, 0, HZ), GREY, segs=10)
    cyl(0.5, 0.25, (HX, top - 0.4, HZ), COLLAR, segs=10)    # under the column's top, not level with it
    for i in range(6, len(helix) - 1, 12):       # spokes from the column to the helix
        x, y, z = helix[i]
        dx, dz = x - HX, z - HZ
        bar((HX + dx * 0.25, y - 0.55, HZ + dz * 0.25), (x - dx * 0.3, y - 0.55, z - dz * 0.3), 0.18, 0.18, GREY)
    end = (69.6, 2.35, -15.3)
    out = [helix[-1], (end[0] + 0.55, end[1] + 0.03, end[2])]
    run_chute(out, 0xe66a5a)
    joint(end[0], end[2], end[1], toward=(helix[-1][0::2], (64.0, -19.5)), color=0xe66a5a)
    run_marbles('vortex', [J0] + in_ + spiral + [(BX, Y0 - 0.2, BZ)] + spout + helix[1:] + out + [end], lite, after='sky')

def run_loop(lite):
    # M: west along the south leg's outside, stepping out round the first
    # car loop, down a ramp into a loop-the-loop of its own beside the mid
    # leg (twin rails, open, so the marble shows going round), and out on
    # the floor to a low cup: the marbles loop where the cars loop.
    J0 = (69.6, 2.35, -15.3)
    line = fillet([toward(J0, (64.0, 2.2, -19.5)), (64.0, 2.2, -19.5), (50.5, 1.95, -21.4), (41.0, 1.7, -21.4), (38.6, 0.65, -21.4)], r=2.0)
    run_chute(line, 0x6cbf6c)
    for x, z in ((66.8, -17.4), (58.0, -20.3), (50.2, -21.3), (45.5, -21.4)):
        trestle(on(resample(line, 0.3), x, z))
    CX, CY, R, Z0, SH = 36.6, 0.65 + 1.2, 1.2, -21.4, 1.0
    loop = [(38.4, 0.65, Z0), (37.4, 0.65, Z0)]
    for i in range(1, 36):
        f = i / 36
        a = 2 * math.pi * f
        loop.append((CX - R * math.sin(a), CY - R * math.cos(a), Z0 - SH * (3 * f * f - 2 * f ** 3)))
    loop += [(CX, 0.65, Z0 - SH), (35.6, 0.65, Z0 - SH), (34.4, 0.65, Z0 - SH)]
    def out(i):                                  # the rails' side: away from the loop's middle, under it on the run in and out
        x, y, _ = loop[i]
        if y < 0.7:
            return (0.0, -1.0, 0.0)
        d = (x - CX, y - CY)
        l = math.hypot(*d)
        return (d[0] / l, d[1] / l, 0.0)
    rails(loop, 0x6cbf6c, out)
    for z in (Z0 + 0.55, Z0 - SH - 0.55):        # the loop's frame: two posts and a bar over its top
        bar((CX, 0.0, z), (CX, CY + R + 0.55, z), 0.2, 0.2, GREY)
        cyl(0.3, 0.12, (CX, 0, z), COLLAR, segs=8)
    bar((CX, CY + R + 0.55, Z0 + 0.55), (CX, CY + R + 0.55, Z0 - SH - 0.55), 0.2, 0.2, GREY)
    end = (33.4, 0.6, Z0 - SH)
    joint(end[0], end[2], end[1], toward=((35.6, Z0 - SH), (26.0, -27.5)), color=0x6cbf6c)
    run_marbles('loop', [J0] + line + loop + [end], lite, after='vortex')

def run_stair(lite):
    # M -> A -> B: low along the floor from the loop, swinging out away from
    # the road (alongside it, a floor chute read as a second kerb) and in
    # across the corner home's outside to a stair lift whose steps rise and
    # fall in turn, the marbles hopping up them to a chute that brings them
    # round onto the marble racer's high end.
    J0 = (33.4, 0.6, -22.4)
    foot = (-1.6, 0.55, -13.4)
    floor = fillet([toward(J0, (26.0, 0.6, -27.5)), (26.0, 0.6, -27.5), (10.0, 0.58, -27.5), (1.4, 0.56, -14.2), foot], r=2.5)
    run_chute(floor, 0xf2c14e)
    for f in (0.15, 0.35, 0.55, 0.75):              # sleepers under it
        a, b = floor[int(len(floor) * f)], floor[int(len(floor) * f) + 1]
        box((1.0, 0.1, 0.3), (a[0], 0.05, a[2]), COLLAR, yaw=math.atan2(b[0] - a[0], b[2] - a[2]))
    dx, dz = foot[0] - J0[0], foot[2] - J0[2]       # the stair's own line
    l = math.hypot(dx, dz)
    dx, dz = dx / l, dz / l
    yaw = math.atan2(dx, dz)
    N, D, S = 11, 0.5, 0.33                        # high enough for the racer's head
    base = foot[1] - RUN_MR - 0.05                  # the chute's floor at the stair's foot
    hop = [foot]
    for k in range(N):
        s0, s1 = 0.15 + k * D, 0.15 + (k + 1) * D
        y = base + S * (k + 1)
        x0, z0 = foot[0] + dx * s0, foot[2] + dz * s0
        x1, z1 = foot[0] + dx * s1, foot[2] + dz * s1
        hop += [(x0, y + RUN_MR, z0), (x1, y + RUN_MR, z1)]
    for g in range(2):                             # the steps, every other one falling a step as its neighbours rise
        with animated('anim_bob:h=%.2f:p=2:o=%.1f#steps%d' % (-S, 0.5 * g, g), (foot[0], 0, foot[2])):
            for k in range(g, N, 2):
                s = 0.15 + (k + 0.5) * D
                y = base + S * (k + 1)
                box((1.0, y, D - 0.04), (foot[0] + dx * s, y / 2, foot[2] + dz * s), TOY[k % 4], yaw=yaw)
    nx, nz = -dz, dx                               # across the stair
    end = (foot[0] + dx * (0.15 + N * D), foot[2] + dz * (0.15 + N * D))
    for side in (-1, 1):                           # its cheeks: the far one over the steps, the road's (-1) half as high so they show
        top0, top1 = (base + 0.1, base + 0.5 * S * N) if side < 0 else (base + S + 0.3, base + S * N + 0.3)
        a, b = 0.62 * side - 0.06, 0.62 * side + 0.06
        slab_on([(foot[0] + nx * a, top0, foot[2] + nz * a), (foot[0] + nx * b, top0, foot[2] + nz * b),
                 (end[0] + nx * b, top1, end[1] + nz * b), (end[0] + nx * a, top1, end[1] + nz * a)], top1, GREY)
    top = hop[-1]
    jx, jh, jz = RACER_FEED                       # the cup behind the racer's head, where its sorter's marbles take over
    high = fillet([(top[0] + dx * 0.3, top[1] - 0.02, top[2] + dz * 0.3), (jx, top[1] - 0.12, -8.2), (jx, jh + 0.03, jz - 0.55)], r=2.0)
    run_chute(high, 0xf2c14e)
    for x, z in ((-7.9, -9.6), (jx, -5.4)):
        trestle(on(resample(high, 0.3), x, z))
    run_marbles('stair', [J0] + floor + hop[1:] + high + [(jx, jh, jz)], lite, after='loop')

RACER_LANES = (0xe66a5a, 0xf2c14e, 0x5a8fd8, 0x6cbf6c)   # the racer's lanes, far side to the road's: the sorter's four colours
RACER_X, RACER_W, RACER_TILT = -7.0, 3.6, -0.55
RACER_FEED = (-8.35, 3.85, -2.2)                 # the cup the stair lift's marbles hand over in: over the far lane's line

def racer_lane(k):
    """Lane k's middle (x)."""
    return RACER_X - RACER_W / 2 + (k + 0.5) * RACER_W / 4

def racer_deck(Z0, Z1, Y0, Y1, T, paint=None, drop=0.0):
    """A deck of the marble racer from Z0 to Z1 (Y0 down to Y1 along its
    middle), tilted toward the road at +X, `T` thick: its four lanes painted
    their colours between `paint` (z0, z1; all of it by default) with the
    dividers between them, the side walls its whole length. Answers its
    surface S(x, z)."""
    X, W = RACER_X, RACER_W
    def S(x, z):
        return Y0 + (Y1 - Y0) * (z - Z0) / (Z1 - Z0) + (x - X) * RACER_TILT - drop
    slab_on([(X - W / 2, S(X - W / 2, Z0), Z0), (X + W / 2, S(X + W / 2, Z0), Z0), (X + W / 2, S(X + W / 2, Z1), Z1),
             (X - W / 2, S(X - W / 2, Z1), Z1)], T, 0xd8a878)
    p0, p1 = paint or (Z0, Z1)
    for k in range(4):
        x0, x1 = X - W / 2 + k * W / 4 + 0.08, X - W / 2 + (k + 1) * W / 4 - 0.08
        quad([(x0, S(x0, p0) + 0.02, p0), (x1, S(x1, p0) + 0.02, p0), (x1, S(x1, p1) + 0.02, p1), (x0, S(x0, p1) + 0.02, p1)][::-1],
             RACER_LANES[k])
    for k in range(5):
        x = X - W / 2 + k * W / 4
        hh = 0.22 if k in (0, 4) else 0.12
        a, b = (Z0, Z1) if k in (0, 4) else (p0, p1)
        bar((x, S(x, a) + hh / 2, a), (x, S(x, b) + hh / 2, b), 0.1 if 0 < k < 4 else 0.16, hh, CREAM)
    return S

def racer_legs(S, T, Z0, Z1):
    X, W = RACER_X, RACER_W
    box((1.4, S(X, Z0 + 0.8) - T + 0.05, 1.4), (X, (S(X, Z0 + 0.8) - T + 0.05) / 2, Z0 + 0.8), 0x9a7b55)   # the stand under its head
    for z in (Z0 + 1.5 + 1.2, (Z0 + Z1) / 2, Z1 - 1.5):                      # its trestles
        for sx in (-1, 1):
            x = X + sx * (W / 2 - 0.3)
            if S(x, z) - T > 0.15:
                bar((x, 0.0, z - 0.7), (x, S(x, z) - T, z), 0.26, 0.26, 0x9a7b55)
                bar((x, 0.0, z + 0.7), (x, S(x, z) - T, z), 0.26, 0.26, 0x9a7b55)

def run_racer(lite):
    # B -> C: the wooden marble racer beside the grid straight on the right,
    # and the run's SORTER: two boards with daylight between them stepping
    # down north, a light bridge of the same four lanes across the gap, the
    # lanes tilted to face the road. The stair lift's marbles come up out of
    # a cup behind its head, mixed, and roll onto the head's open deck at its
    # far, high side; each rolls down the tilt across the head as far as the
    # gate of its own colour and turns through it, so every lane races only
    # marbles of its colour beside the cars. At the foot they roll on down
    # the tilt along a gutter and drop through the hole at its road end into
    # the board. Four chains, one a colour, their loops padded under the
    # floor to one length, so the marbles keep their order and their gaps
    # where they share the feed and the gutter. From the foot a floor chute
    # swings out away from the road and round behind the slinky and its block
    # (in front of them it hid the block and read as a second kerb) to a cup
    # at the marble tower's back, and up its column the marbles go round
    # again.
    X, W, T = RACER_X, RACER_W, 0.8
    A0, A1, B0, B1 = 1.5, 22.5, 26.0, 47.0        # the two boards
    HEAD, FOOT = 1.0, 1.0                         # the open deck at the head, the gutter at the foot
    S0 = racer_deck(A0, A1, 2.45, 1.95, T, paint=(A0 + HEAD, A1))
    S1 = racer_deck(B0, B1, 1.75, 1.25, T, paint=(B0, B1 - FOOT))
    SB = racer_deck(A1 - 0.05, B0 + 0.05, S0(X, A1 - 0.05), S1(X, B0 + 0.05), 0.25, drop=0.03)   # the bridge, let into both
    racer_legs(S0, T, A0, A1)
    racer_legs(S1, T, B0, B1)
    # the gates: a comb across the head, a bar of each lane's colour over it
    za = A0 + HEAD
    for k in range(5):
        x = X - W / 2 + k * W / 4
        bar((x, S0(x, za) + 0.1, za), (x, S0(x, za) + 1.05, za), 0.14, 0.14, CREAM)
    for k in range(4):
        x0, x1 = X - W / 2 + k * W / 4, X - W / 2 + (k + 1) * W / 4
        bar((x0, S0(x0, za) + 1.05, za), (x1, S0(x1, za) + 1.05, za), 0.3, 0.3, RACER_LANES[k])
    bar((X - W / 2, S1(X - W / 2, B1) + 0.15, B1), (X + W / 2, S1(X + W / 2, B1) + 0.15, B1), 0.16, 0.3, CREAM)   # the gutter's end wall
    zf = B1 - FOOT / 2
    xo = racer_lane(3)
    # the feed: out of the hand-over cup onto the head's far side
    R = RUN_MR * 1.06
    jx, jh, jz = RACER_FEED
    x_in = racer_lane(0)
    joint(jx, jz, jh, toward=((jx, jz - 1.0), (x_in, A0)), color=0xa878e8)
    feed = [(jx, jh + 0.03, jz + 0.55), (x_in, S0(x_in, A0) + R + 0.1, A0 - 0.05)]
    run_chute(feed, 0xa878e8)
    trestle(feed[1])
    zc = A0 + HEAD / 2
    def on0(x, z): return (x, S0(x, z) + R, z)
    def on1(x, z): return (x, S1(x, z) + R, z)
    loops = []
    for k in range(4):
        x = racer_lane(k)
        deck = [feed[1], on0(x_in, zc)] + ([on0(x, zc)] if k else []) + [on0(x, za + 0.6), on0(x, A1), on1(x, B0), on1(x, zf)]
        deck += [on1(xo, zf)] if k < 3 else []
        seen = [(jx, jh, jz), feed[0]] + fillet(deck, r=0.45, n=4) + [(xo, S1(xo, zf) - 0.5, zf)]
        loops.append(seen)
    # the foot: a box with a lid over the hole, the gutter and the last lane
    # running into it, the chute home running out of it
    by = S1(xo, zf)
    box((1.3, 1.5, 1.3), (xo, by + 0.6, zf + 0.05), 0x6cbf6c)
    box((1.5, 0.2, 1.5), (xo, by + 1.45, zf + 0.05), CREAM)
    mouth((xo - 0.6, by + R + 0.25, zf), (xo - 2.0, zf), w=0.9, h=0.9)
    mouth((xo, by + R + 0.1, zf - 0.55), (xo, zf - 2.0), w=0.8, h=0.9)
    for k, seen in enumerate(loops):
        run_marbles('sort%d' % k, seen[:-1], lite, after='stair', lane=k)
    # the chute home: out of the box, away from the road, round behind the
    # slinky and into the marble tower's foot
    tx, tz = TOWER
    port = (tx - 0.95, 0.68, tz - 0.35)           # on the column's west side, where its own helix stands highest over the floor
    floor = fillet([(xo, 0.72, zf + 0.6), (xo, 0.72, B1 + 1.2), (-12.5, 0.7, 54.0), (-13.0, 0.68, 64.0), port], r=2.2)
    run_chute(floor, 0x6cbf6c)
    mouth((xo, 0.75, zf + 0.72), (xo, zf + 2.0), w=1.2, h=0.9)
    mouth((tx - 0.7, 0.65, tz - 0.26), (-13.0, 64.0), w=1.25, h=1.3)   # down to the floor: the column is the tower's own piece
    run_marbles('home', [(xo, by + R, zf)] + floor + [(tx, 0.66, tz)], lite)

RUN_BUILD = {'head': run_head, 'wheel': run_wheel, 'summit': run_summit, 'skyway': run_skyway,
             'vortex': run_vortex, 'loop': run_loop, 'stair': run_stair, 'racer': run_racer}
for _n in RUN_BUILD:
    for _lite in (False, True):
        _name = 'marble-run-%s%s' % (_n, '-lite' if _lite else '')
        PIECES[_name] = (lambda n, lite: lambda: run_section(n, lite))(_n, _lite)
        GROW[_name] = 1.0

@piece(1.0)
def toy_garage():
    # Skysnake: the racers' home, a multi-storey toy car park beside the
    # grid in the track's green and yellow, about 20 cm tall (low, so a
    # racer's eye looks down onto its ramp): a ground floor and a deck on four
    # green columns, the roof a second deck, and on the roof a blue P block
    # (the alphabet blocks' own) that says car park from down the straight
    # where the open decks alone read as shelving. Its front (+X) faces the
    # road. A toy car rides the lift up the front and
    # down again (the platform bobs, the car on it), and two more roll down
    # the spiral ramp at the side (+Z), half a loop apart, drive into the floor and go
    # back up INSIDE the stair core at the back, out of sight, to the roof:
    # the one place in the room a car goes uphill, and it does it on a
    # machine or out of sight. Nothing else moves: no parked cars, so every
    # toy car here moves.
    GREEN, YEL, RED = 0x5cb168, 0xf2c14e, 0xe66a5a
    W, FLOORS, T = 7.0, (1.7, 3.4), 0.25                       # body width, deck tops, slab
    box((W + 0.6, 0.2, W + 0.6), (0, 0.1, 0), GREEN)                            # the base board
    for y in FLOORS:
        box((W, T, W), (0, y - T / 2, 0), YEL)                                   # the decks
        box((0.12, T + 0.1, W + 0.04), (W / 2 + 0.06, y - T / 2, 0), GREEN)      # a green fascia to the road
    # the columns stand 0.05 proud of the decks' edges: flush with them, a
    # column's green face and a deck's yellow edge shared a plane and flickered
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((0.5, FLOORS[-1] + 0.3, 0.5), (sx * (W / 2 - 0.2), (FLOORS[-1] + 0.3) / 2, sz * (W / 2 - 0.2)), GREEN)
    # parking bays painted on each deck and the floor
    for y in (0.2,) + FLOORS:
        for k in range(3):
            z = -2.0 + k * 1.6
            quad([(0.4, y + 0.01, z - 0.04), (2.9, y + 0.01, z - 0.04), (2.9, y + 0.01, z + 0.04), (0.4, y + 0.01, z + 0.04)], 0xfdf4de)
    # the stair core at the back, where the ramp car climbs out of sight, a
    # door at the floor and at the roof
    CX = -2.3
    box((2.0, FLOORS[-1] + 1.0, 2.0), (CX, (FLOORS[-1] + 1.0) / 2 + 0.2, 0), GREEN)
    box((2.3, 0.3, 2.3), (CX, FLOORS[-1] + 1.35, 0), YEL)                        # its cap
    for y in (0.2, FLOORS[-1]):
        plate_x(CX + 1.01, y, y + 0.8, -0.5, 0.5, 0x2a2735)
    block(1.2, (W / 2 - 0.95, FLOORS[-1] + 0.6, W / 2 - 0.95), 0x5a8fd8, faces=('+x', '+z', '-x', '-z', '+y'),
          letters={'+x': 'P', '+z': 'P'})                                         # the car park's sign
    # the lift up the front: two red rails, a beam over them, the platform
    LX = W / 2 + 0.75
    for sz in (-1, 1):
        box((0.3, FLOORS[-1] + 1.2, 0.3), (LX, (FLOORS[-1] + 1.2) / 2, sz * 0.95), RED)
    box((0.4, 0.35, 2.3), (LX, FLOORS[-1] + 1.2, 0), RED)
    with animated('anim_bob:h=3.1:p=8:r=0.1#lift', (LX, 0.25, 0)):
        box((1.3, 0.16, 1.5), (LX, 0.3, 0), YEL)
        o0 = set(bpy.context.scene.objects)
        mini_car(LX, 0, 0x5a8fd8)
        for o in set(bpy.context.scene.objects) - o0:
            o.location.z += 0.38                                                 # Blender Z is up
    # the spiral ramp down the side: a low-lipped chute round a green post,
    # two turns from the roof's edge to the floor
    RZ, RR, TOP, LOW = W / 2 + 2.5, 2.4, FLOORS[-1] + 0.02, 0.24
    cyl(0.45, TOP + 0.6, (0, 0, RZ), GREEN, segs=10)
    spiral = helix_pts(0, RZ, RR, TOP, LOW, -math.pi / 2, 2, per=16)
    chute(spiral, YEL, 0.0, half=0.6, wall=0.12)
    for i in range(4, len(spiral) - 1, 8):                                       # spokes to the post
        p = spiral[i]
        dx, dz = p[0], p[2] - RZ
        l = math.hypot(dx, dz)
        bar((dx / l * 0.45, p[1] - 0.15, RZ + dz / l * 0.45), (p[0] - dx / l * 0.55, p[1] - 0.15, p[2] - dz / l * 0.55),
            0.2, 0.2, GREEN)
    # the ramp car's loop: down the spiral, in across the floor, up the core
    # out of sight, out across the roof to the spiral's top
    loop = spiral + [(0.0, LOW, 2.0), (CX + 0.6, LOW, 0.4), (CX, LOW, 0.0)]
    loop += [(CX, LOW + (TOP - LOW) * j / 5, 0.0) for j in range(1, 6)]
    loop += [(CX + 0.6, TOP, 0.4), (0.0, TOP, 2.0)]
    for k, p in enumerate(loop):
        marker('path_ramp_%d' % k, p)
    for m, c in enumerate((RED, 0xa878e8)):                                      # two, half a loop apart
        with animated('anim_path:c=ramp:p=14:f=2:o=%.1f#%d' % (m / 2, m), spiral[0]):
            o0 = set(bpy.context.scene.objects)
            mini_car(spiral[0][0], spiral[0][2], c, along_x=True)
            for o in set(bpy.context.scene.objects) - o0:
                o.location.z += spiral[0][1]
    merge_paint()

# ---- Gauntlet: the besiegers ----

# The castle's knights wear its blue, the besiegers' red: one toy set of
# knights split into two sides, as a child plays it.
DEFENDERS, BESIEGERS = 0x5a8fd8, 0xff5040

def soldier(at, color):
    # a toy knight facing +X: hose, a surcoat with its cross, belt and arms,
    # a great helm with its slit and plume, a spear at his side and his
    # shield before him. Square-edged: his parts are a few tenths of a unit,
    # where a chamfer cannot be seen and nearly quadruples what a rank costs
    # up close. The piece he stands in keeps its chamfered frame, which is
    # what lets the bake cut it a far form (TtpRenderer::farForm).
    with plain_parts():
        _soldier(at, color)

def _soldier(at, color):
    x, y, z = at
    box((0.58, 1.0, 0.48), (x, y + 0.5, z), 0x2a2735)
    box((0.7, 1.0, 0.56), (x, y + 1.5, z), color)
    box((0.72, 0.14, 0.58), (x, y + 1.15, z), 0x9a7b55)
    plate_x(x + 0.375, y + 1.25, y + 1.95, z - 0.06, z + 0.06, 0xfdf4de)     # painted marks stand 0.025 off their part (0.014 at a
    plate_x(x + 0.375, y + 1.62, y + 1.74, z - 0.22, z + 0.22, 0xfdf4de)     # knight's size): at 0.002 the shield's cross flickered
    for s in (-1, 1):
        box((0.3, 0.85, 0.24), (x, y + 1.55, z + s * 0.4), color)
        box((0.26, 0.24, 0.22), (x, y + 1.02, z + s * 0.4), 0xf2bf99)
    box((0.56, 0.72, 0.56), (x, y + 2.36, z), 0x9aa1b4)                    # the helm
    plate_x(x + 0.305, y + 2.36, y + 2.48, z - 0.2, z + 0.2, 0x2a2735)      # its eye slit
    box((0.12, 0.6, 0.46), (x, y + 3.0, z), color)                          # the plume
    box((0.14, 2.5, 0.14), (x + 0.06, y + 1.75, z + 0.59), 0x9a7b55)       # the spear,
    cyl(0.16, 0.45, (x + 0.06, y + 3.0, z + 0.59), 0x9aa1b4, r2=0.02, segs=4)  # its head
    box((0.12, 0.95, 0.66), (x + 0.44, y + 1.45, z - 0.38), color)          # the shield
    plate_x(x + 0.525, y + 1.05, y + 1.85, z - 0.44, z - 0.32, 0xfdf4de)
    plate_x(x + 0.525, y + 1.5, y + 1.62, z - 0.66, z - 0.1, 0xfdf4de)

@piece(0.55)
def toy_soldiers():
    # Gauntlet: a rank of four of the castle's toy knights on their stand,
    # 9 cm tall, guarding the road.
    box((1.2, 0.2, 6.4), (0, 0.1, 0), 0x6cbf6c)
    for k in range(4):
        soldier((0, 0.2, -2.25 + k * 1.5), DEFENDERS)
    # their toy cannon, run out toward the road
    for s in (-1, 1):
        cyl(0.55, 0.18, (1.6, 0.55, 4.6 + s * 0.6 - 0.09), 0xb06041, segs=8, axis='along')
    box((0.7, 0.5, 1.0), (1.6, 0.7, 4.6), 0x6cbf6c)
    cyl(0.32, 2.0, (0.9, 1.0, 4.6), 0x38383d, r2=0.26, segs=8, axis='across')
    merge_paint()

@piece(0.55)
def siege_tower():
    # Gauntlet: the besiegers' toy siege tower (about 30 cm, a wooden toy at
    # the soldiers' own scale) rolled up on its four wheels, its drawbridge
    # raised against its face (+X, the side it rolls toward: the castle and
    # the road), a pennant flapping over its battlements, and a rank of four
    # soldiers marching before it: the siege's tallest piece, so it reads
    # down a long straight where a rank alone is a speck.
    W, D = 5.4, 5.4                               # its footprint, X by Z
    WOODC, DARK = 0xc8955a, 0x7a5a3a
    for sx in (-1, 1):                            # the wheels, hubs out
        for sz in (-1, 1):
            z = D / 2 if sz > 0 else -D / 2 - 0.6
            cyl(1.1, 0.6, (sx * 1.6, 1.1, z), DARK, segs=10, axis='along')
            cyl(0.4, 0.7, (sx * 1.6, 1.1, z - 0.05), 0xf2c14e, segs=6, axis='along')
    box((W, 0.7, D), (0, 1.45, 0), DARK)                                          # the bed
    box((W, 3.8, D), (0, 3.7, 0), WOODC)                                          # the storeys
    box((W - 0.5, 3.2, D - 0.5), (0, 7.2, 0), WOODC)
    box((W + 0.4, 0.4, D + 0.4), (0, 9.0, 0), DARK)                               # the fighting deck
    for i, (x, z) in enumerate(((-1, -1), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0))):
        box((0.9, 0.9, 0.9), (x * (W / 2 - 0.25), 9.65, z * (D / 2 - 0.25)), TOY[i % 4])    # battlements
    for y in (1.8, 5.6):                                                          # plank seams round it
        box((W + 0.08, 0.16, D + 0.08), (0, y, 0), DARK)
    for sz in (-1, 1):                                                            # its sides: a brace, a shield
        z = sz * (D / 2 + 0.04)
        bar((-W / 2 + 0.4, 2.1, z), (W / 2 - 0.4, 5.3, z), 0.3, 0.2, DARK)
        bar((-W / 2 + 0.4, 5.3, z), (W / 2 - 0.4, 2.1, z), 0.3, 0.2, DARK)
        zu = sz * (D - 0.5) / 2                                                   # on the upper storey
        cyl(1.1, 0.2, (0, 7.2, zu if sz > 0 else zu - 0.2), 0x5a8fd8, segs=10, axis='along')
        cyl(0.4, 0.3, (0, 7.2, zu if sz > 0 else zu - 0.3), 0xf2c14e, segs=6, axis='along')
    # the drawbridge, raised: a red board hinged at the upper storey's floor,
    # leaning a little off the face, its two chains up to the deck
    box((0.3, 3.4, 3.4), (W / 2 + 0.2, 7.3, 0), 0xe66a5a, roll=-0.08)
    for z in (-1.0, 0.0, 1.0):
        box((0.12, 3.2, 0.12), (W / 2 + 0.38, 7.3, z), 0xa84a3e, roll=-0.08)
    for sz in (-1, 1):
        bar((W / 2 + 0.45, 8.9, sz * 1.5), (W / 2 - 0.1, 9.1, sz * 1.5), 0.2, 0.2, 0x2a2735)
    box((BAR * 1.6, 3.7, BAR * 1.6), (0, 11.05, 0), 0x2a2735)                    # the pennant's pole
    with animated('anim_sway:a=x:d=24:p=1.9#pennant', (0, 12.8, 0)):
        box((0.08, 0.9, 1.6), (0, 12.35, 0.85), 0x6cbf6c)
        box((0.08, 0.5, 0.8), (0, 12.35, 2.0), 0x6cbf6c)
    # the rank before it, on their stand
    box((1.2, 0.2, 6.4), (W / 2 + 2.6, 0.1, 0), 0x6cbf6c)
    for k in range(4):
        soldier((W / 2 + 2.6, 0.2, -2.25 + k * 1.5), BESIEGERS)
    merge_paint()

@piece(0.55)
def trebuchet():
    # Gauntlet: the besiegers' toy trebuchet (about 40 cm to its arm's tip, a
    # wooden kit at the soldiers' own scale) on its wheeled frame, its arm
    # just thrown and standing high over the frame toward its target (-Z),
    # the sling hanging empty from its tip, the counterweight swung down; its
    # crew of three before it. The arm swings in the YZ plane, so it reads
    # side on, from +X (the crew's side).
    WOODC, DARK = 0xc8955a, 0x7a5a3a
    for sx in (-1, 1):
        box((0.6, 0.6, 9.0), (sx * 2.2, 0.9, 0), DARK)                        # the frame's rails
        for z in (-3.6, 3.6):                                                 # its wheels, hubs out
            cyl(0.9, 0.5, (sx * 2.75, 0.9, z), DARK, segs=10, axis='across')
            cyl(0.35, 0.6, (sx * 2.8, 0.9, z), 0xf2c14e, segs=6, axis='across')
        bar((sx * 2.2, 1.2, -3.4), (sx * 2.2, 7.4, 0), 0.55, 0.55, WOODC)     # the A of each side
        bar((sx * 2.2, 1.2, 3.4), (sx * 2.2, 7.4, 0), 0.55, 0.55, WOODC)
        bar((sx * 2.2, 3.4, -2.2), (sx * 2.2, 3.4, 2.2), 0.4, 0.4, DARK)      # and its cross bar
    for z in (-4.0, 4.0):
        box((5.0, 0.5, 0.6), (0, 0.9, z), DARK)                               # the frame's ends
    cyl(0.35, 5.4, (-2.7, 7.4, 0), 0x9aa1b4, segs=8, axis='across')           # the axle
    tip = (0, 7.4 + 7.6 * math.sin(math.radians(66)), -7.6 * math.cos(math.radians(66)))
    tail = (0, 7.4 - 2.6 * math.sin(math.radians(66)), 2.6 * math.cos(math.radians(66)))
    bar(tail, tip, 0.6, 0.6, 0xe66a5a)                                        # the throwing arm, thrown
    box((2.4, 2.0, 2.0), (0, tail[1] - 1.1, tail[2]), 0x5a8fd8)               # the counterweight, swung down
    sling = (0, tip[1] - 2.2, tip[2] - 0.9)
    bar(tip, sling, 0.12, 0.12, 0xfdf4de)
    box((0.5, 0.3, 0.7), sling, 0x9a7b55)                                     # its pouch, the shot gone
    # the crew before it, on their stand
    box((1.2, 0.2, 4.6), (4.6, 0.1, 0), 0x6cbf6c)
    for k in range(3):
        soldier((4.6, 0.2, -1.5 + k * 1.5), BESIEGERS)
    merge_paint()

# ---- Gauntlet: the castle the lap rings, and the camp across the ramp ----

class transformed:
    """Parts built inside are turned `yaw` about the upright through `at`
    (box()'s sense) and sized by `k` about it: a knight built facing +X at a
    toy set's own size, stood on a wall facing its own way. Nothing that
    moves goes inside: its pivot would stay where it was built."""
    def __init__(self, at, yaw=0.0, k=1.0):
        self.at, self.yaw, self.k = at, yaw, k
    def __enter__(self):
        self.before = set(bpy.context.scene.objects)
        return self
    def __exit__(self, *exc):
        bpy.context.view_layer.update()
        c = P(*self.at)
        m = Matrix.Translation(c) @ Matrix.Rotation(self.yaw, 4, 'Z') @ Matrix.Scale(self.k, 4) @ Matrix.Translation(-c)
        for o in bpy.context.scene.objects:
            if o not in self.before and o.parent is None:
                o.matrix_world = m @ o.matrix_world
        return False

def knight(at, color, yaw):
    """One of the toy knights (soldier()) at the toy set's size, facing (cos
    yaw, -sin yaw)."""
    with transformed(at, yaw, 0.55):
        soldier(at, color)

def block_run(a, b, y, color0, courses=1, faces=('+x',), letters=True, crenels=False):
    """A wall of alphabet blocks from (x, z) a to b along X or Z, whole
    blocks about 1.3 a side, `courses` high from `y`, its cream panels on
    `faces` (the face turned to the road) and a letter on every other one."""
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    n = max(1, round(L / 1.3))
    s = L / n
    along_x = abs(b[0] - a[0]) > abs(b[1] - a[1])
    for c in range(courses):
        for i in range(n):
            f = (i + 0.5) / n
            x, z = a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
            lt = {faces[0]: ABC[(i * 3 + c * 5) % 8]} if letters and (i + c) % 2 == 0 else None
            block(s, (x, y + s / 2 + c * s, z), TOY[(i + c + color0) % 4], faces=faces, letters=lt)
            if crenels and c == courses - 1 and i % 2 == 0:
                box((s * 0.55 if along_x else s * 0.6, s * 0.45, s * 0.6 if along_x else s * 0.55),
                    (x, y + courses * s + s * 0.22, z), 0xf2c14e)
    return y + courses * s

def block_tower(x, z, T, n, color0, roof, face, pennant=None, fly=1):
    """A corner tower: `n` big blocks of `T` stacked, a cone roof, and the
    castle's blue pennant on a tall pole over it that sways (`pennant`
    names its motion), flying toward +Z (`fly` -1: toward -Z). The pole
    stands well over the walls, so the flag crosses the chase camera's
    frame as the road swings round each corner."""
    for j in range(n):
        block(T, (x, T / 2 + j * T, z), TOY[(j + color0) % 4], faces=('+x', '-x', '+z', '-z'),
              letters={face: ABC[(j * 3 + color0) % 8]})
    top = n * T
    cyl(T * 0.72, T * 0.9, (x, top, z), roof, r2=0.05, segs=10)
    if pennant:
        box((BAR * 1.4, 3.4, BAR * 1.4), (x, top + 1.9, z), 0x2a2735)
        with animated(pennant, (x, top + 3.5, z)):
            box((0.08, 1.15, 1.8), (x, top + 2.95, z + fly * 0.95), 0x5a8fd8)
            box((0.08, 0.6, 0.9), (x, top + 2.95, z + fly * 2.2), 0x5a8fd8)
            box((0.1, 0.42, 0.42), (x, top + 2.95, z + fly * 0.95), 0xf2c14e)
    return top

@piece(1.0)
def block_fortress():
    # Gauntlet: the toy castle the lap is laid round, built of the alphabet
    # blocks a child keeps. It fills the
    # loop the road makes inside the lap (placed so its frame is the
    # world's: +Z toward the ramp, +X toward the ring's run home), so the
    # racers circle its walls on four sides: a curtain wall of one course
    # with its crenels, low enough that the towers, the keep and the knights
    # over it stand in the chase camera's view from beside it (two courses
    # read as a wall of letter blocks with the castle out of frame), a big
    # tower at each corner flying a red pennant and a smaller one halfway
    # along each wall the road runs beside, the gatehouse in the wall
    # toward the ramp with its drawbridge down toward the besiegers' camp
    # beyond, the keep standing over the court with the king's banner, and
    # the castle's blue knights on the wall walk. Every wall stands 3 u off
    # the kerb, its panels and letters to the road.
    TX, TZ, T = 8.25, 6.4, 1.8                    # the corner towers' centres, their block
    S = 1.3
    TSE = S                                       # the corner the racers pass closest, round its
                                                  # bend: the wall's own blocks, never one big
                                                  # letter block filling the frame's edge
    # the curtain wall, between the towers' faces; the gate in the +Z wall,
    # a mid-wall tower in each of the others
    GW = 1.25                                     # half the gateway's opening
    GT = GW + S / 2                               # the gate towers' centres
    M = S / 2                                     # half a mid-wall tower
    wall_top = {}                                 # each wall's height, for the knights on it
    wall_top['n'] = block_run((-TX + T / 2, TZ), (-GT - S / 2, TZ), 0.0, 1, faces=('+z', '+y'), crenels=True)
    block_run((GT + S / 2, TZ), (TX - T / 2, TZ), 0.0, 2, faces=('+z', '+y'), crenels=True)
    wall_top['s'] = block_run((-TX + T / 2, -TZ), (-M, -TZ), 0.0, 3, faces=('-z', '+y'), crenels=True)
    wall_top['se'] = block_run((M, -TZ), (TX - TSE / 2, -TZ), 0.0, 1, faces=('-z', '+y'), crenels=True)
    for sx in (-1, 1):
        face = '+x' if sx > 0 else '-x'
        wall_top['xs' if sx > 0 else 'ws'] = block_run((sx * TX, -TZ + (TSE if sx > 0 else T) / 2), (sx * TX, -M), 0.0,
                                                      0 if sx > 0 else 2, faces=(face, '+y'), crenels=True)
        wall_top['x'] = block_run((sx * TX, M), (sx * TX, TZ - T / 2), 0.0, 3 if sx > 0 else 1, faces=(face, '+y'), crenels=True)
    for k, (x, z, face) in enumerate(((0.0, -TZ, '-z'), (TX, 0.0, '+x'), (-TX, 0.0, '-x'))):
        for j in range(3):
            block(S, (x, S / 2 + j * S, z), TOY[(j + k + 1) % 4], faces=('+x', '-x', '+z', '-z'),
                  letters={face: ABC[(3 * j + k) % 8]} if j != 1 else None)
        cyl(S * 0.75, S * 0.85, (x, 3 * S, z), (0x5a8fd8, 0xf2c14e, 0x6cbf6c)[k], r2=0.05, segs=10)
    # the corner towers
    n = 0
    for sx in (-1, 1):
        for sz in (-1, 1):
            face = '+x' if sx > 0 else '-x'
            se = sx > 0 and sz < 0
            block_tower(sx * TX, sz * TZ, TSE if se else T, 4 if se else 3, n, 0x6cbf6c if (sx + sz) == 0 else 0xe66a5a, face,
                        pennant='anim_sway:a=x:d=24:p=%.1f#%d' % (1.7 + 0.2 * n, n), fly=-sz)   # over the court, clear of the ring
            n += 1
    # the gatehouse: a tower of four blocks either side of the opening, the
    # lintel over it, the dark gateway, the drawbridge down on the floor
    for sx in (-1, 1):
        for j in range(4):
            block(S, (sx * GT, S / 2 + j * S, TZ), TOY[(j + (sx > 0)) % 4], faces=('+z', '+x' if sx > 0 else '-x'),
                  letters={'+z': ABC[(2 * j + (sx > 0)) % 8]})
        cyl(S * 0.75, S * 0.85, (sx * GT, 4 * S, TZ), 0x5a8fd8, r2=0.05, segs=10)
    for sx, c, ch in ((-1, 0xf2c14e, 'A'), (1, 0xe66a5a, 'H')):                  # the lintel's two blocks
        block(GW, (sx * GW / 2, 2 * S + GW / 2, TZ), c, faces=('+z', '+y'), letters={'+z': ch})
    for sx in (-1, 1):
        box((S * 0.5, S * 0.45, S * 0.6), (sx * GW / 2, 2 * S + GW + S * 0.22, TZ), 0xf2c14e)
    box((2 * GW, S * 2, S * 0.7), (0, S, TZ + 0.05), 0x3a2a22)                       # the gateway, dark
    box((2 * GW + 0.4, 0.16, S * 0.9), (0, 2 * S + 0.02, TZ), 0x7a5a3a)             # its lintel beam
    L = 2.5
    box((2 * GW - 0.2, 0.16, L), (0, 0.14, TZ + S / 2 + L / 2), 0xb08a5a, pitch=-0.05)  # the drawbridge
    for sx in (-1, 1):
        tube([(sx * (GW - 0.25), S * 1.9, TZ + S / 2 + 0.05), (sx * (GW - 0.25), 0.32, TZ + S / 2 + L - 0.15)],
             0.03, 0x2a2735, res=2, bevel_res=0)
    # the keep over the court: four big blocks a course, three courses, a
    # crenel at each corner, a pyramid roof and the king's banner on its pole
    K, KZ = 1.6, -0.6
    for j in range(3):
        for i, (dx, dz) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
            block(K, (dx * K / 2, K / 2 + j * K, KZ + dz * K / 2), TOY[(i + j) % 4],
                  faces=('+x' if dx > 0 else '-x', '+z' if dz > 0 else '-z'),
                  letters={('+z' if dz > 0 else '-z'): ABC[(i * 2 + j) % 8]} if (i + j) % 2 == 0 else None)
    KT = 3 * K
    for dx, dz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        box((0.6, 0.55, 0.6), (dx * (K - 0.3), KT + 0.27, KZ + dz * (K - 0.3)), 0xf2c14e)
    cyl(K * 1.05, 1.9, (0, KT, KZ), 0x5a8fd8, r2=0.05, segs=4, yaw=math.pi / 4)
    box((BAR * 1.6, 2.4, BAR * 1.6), (0, KT + 1.9 + 1.0, KZ), 0x2a2735)
    with animated('anim_sway:a=x:d=20:p=2.6#banner', (0, KT + 1.9 + 2.15, KZ)):
        box((0.08, 1.1, 1.9), (0, KT + 1.9 + 1.6, KZ + 1.0), 0x5a8fd8)
        box((0.1, 0.4, 0.4), (0, KT + 1.9 + 1.6, KZ + 1.0), 0xf2c14e)
    # the castle's blue knights on the wall walk, behind the crenels: two
    # either side of the gate, facing the camp, one on each other wall
    for x in (-5.55, -3.15, 4.35, 6.75):          # on the blocks the crenels leave free
        knight((x, wall_top['n'], TZ - 0.15), DEFENDERS, -math.pi / 2)
    knight((-2.66, wall_top['s'], -TZ + 0.15), DEFENDERS, math.pi / 2)
    knight((2.74, wall_top['se'], -TZ + 0.15), DEFENDERS, math.pi / 2)
    knight((TX - 0.15, wall_top['xs'], -3.84), DEFENDERS, 0.0)
    knight((TX - 0.15, wall_top['x'], 2.47), DEFENDERS, 0.0)
    knight((-TX + 0.15, wall_top['x'], 2.47), DEFENDERS, math.pi)
    merge_paint()

def pavilion(x, z, r, h, wall, roof, trim=0xfdf4de, flag=0xff5040):
    """A knight's pavilion: a round striped wall (eight panels, the wall's
    colour and cream by turns), a gored cone roof over it, a scalloped trim
    at the eaves, the dark door to +X and a pennant on its pole."""
    n = 8
    w = 2 * r * math.tan(math.pi / n) + 0.02
    for i in range(n):
        a = i * 2 * math.pi / n
        box((0.1, h, w), (x + r * math.cos(a), h / 2, z + r * math.sin(a)), wall if i % 2 == 0 else trim, yaw=-a + math.pi / 2)
    top = (x, h + r * 1.05, z)
    for i in range(n):
        a0, a1 = (i - 0.5) * 2 * math.pi / n, (i + 0.5) * 2 * math.pi / n
        rim0 = (x + math.cos(a0) * (r + 0.25) / math.cos(math.pi / n), h, z + math.sin(a0) * (r + 0.25) / math.cos(math.pi / n))
        rim1 = (x + math.cos(a1) * (r + 0.25) / math.cos(math.pi / n), h, z + math.sin(a1) * (r + 0.25) / math.cos(math.pi / n))
        poly([top, rim0, rim1], [(0, 1, 2)], roof if i % 2 == 0 else trim)
    for i in range(n):                                           # the scallops at the eaves
        a = i * 2 * math.pi / n
        box((0.08, 0.28, w * 0.7), (x + (r + 0.22) * math.cos(a), h - 0.12, z + (r + 0.22) * math.sin(a)), roof, yaw=-a + math.pi / 2)
    plate_x(x + r + 0.06, 0.0, h * 0.7, z - 0.3, z + 0.3, 0x3a2a22)          # the door
    box((BAR, 1.0, BAR), (x, top[1] + 0.4, z), 0x2a2735)
    box((0.08, 0.36, 0.7), (x, top[1] + 0.72, z + 0.36), flag)

def ram(x, z, swing=None):
    """The besiegers' battering ram, rolled up ready: a roofed timber frame
    on four wheels, its iron-headed log slung under the roof's ridge,
    pointing -Z (at the castle); `swing` names the log's motion on its
    slings (a pendulum along the frame, hung from the ridge)."""
    WOODC, DARK = 0xc8955a, 0x7a5a3a
    for sx in (-1, 1):
        for sz in (-1, 1):
            cyl(0.6, 0.3, (x + sx * 1.15, 0.6, z + sz * 1.3), DARK, segs=10, axis='across')
        box((0.3, 0.3, 3.6), (x + sx * 1.0, 0.75, z), DARK)                       # the bed's rails
        for sz in (-1, 1):
            box((0.25, 2.0, 0.25), (x + sx * 1.0, 1.9, z + sz * 1.5), WOODC)       # its posts
    for s in (-1, 1):                                                           # the gabled roof
        box((1.5, 0.14, 3.9), (x + s * 0.62, 3.25, z), 0xe66a5a, roll=s * 0.75)
    box((0.3, 0.3, 4.0), (x, 3.75, z), DARK)                                    # the ridge
    with animated(swing, (x, 3.6, z)) if swing else contextlib.nullcontext():
        cyl(0.32, 4.6, (x, 1.9, z - 2.5), 0x9a7b55, segs=8, axis='along', stem=True) # the log
        cyl(0.3, 0.6, (x, 1.9, z - 3.1), 0x868ba1, r2=0.42, segs=8, axis='along')    # its iron head
        for sz in (-0.9, 0.9):                                                       # the slings
            box((0.1, 1.7, 0.1), (x, 2.9, z + sz), 0x2a2735)

@piece(1.0)
def siege_camp():
    # Gauntlet: the besiegers' camp in the infield across the ramp from the
    # castle (placed so its frame is the world's, the castle toward -Z): a
    # ring of knights' pavilions striped in the red side's colours, the
    # commander's big one in the middle with the red standard over it, a
    # supply cart and barrels, a rank marching out toward the castle, and
    # the battering ram rolled up ready. The trebuchet and a siege tower
    # stand before it, nearer the ramp (their own pieces). Tents stand
    # within a few units of the grid straight, the east leg and the boost
    # leg, their doors to the camp's middle.
    R0, CR = 0xff5040, 0xfdf4de
    for x, z, r, h, wall, roof in ((-13.6, -2.4, 1.35, 1.5, R0, R0), (-13.4, 2.1, 1.25, 1.4, 0xf2c14e, R0),
                                   (-8.4, 2.6, 1.3, 1.5, R0, 0xf2c14e), (-3.6, 2.6, 1.25, 1.4, 0x6cbf6c, R0),
                                   (5.6, 2.6, 1.3, 1.5, R0, R0), (10.2, 2.1, 1.25, 1.4, 0xf2c14e, R0),
                                   (14.4, -2.2, 1.3, 1.5, R0, 0x6cbf6c)):
        # each tent turned so its door faces the camp's middle
        a = math.atan2(-0.5 - z, 1.0 - x)
        with transformed((x, 0, z), -a):
            pavilion(x, z, r, h, wall, roof)
    # the commander's pavilion, and the standard over the camp
    pavilion(1.0, -0.4, 1.9, 1.9, R0, R0, flag=0xf2c14e)
    box((BAR * 1.6, 3.6, BAR * 1.6), (3.4, 1.8, -2.4), 0x2a2735)
    with animated('anim_sway:a=x:d=22:p=2.4#standard', (3.4, 3.55, -2.4)):
        box((0.08, 1.2, 2.0), (3.4, 2.9, -1.35), R0)
        box((0.1, 0.45, 0.45), (3.4, 2.9, -1.35), 0xf2c14e)
    # the supply cart and its barrels
    WOODC, DARK = 0xc8955a, 0x7a5a3a
    box((1.6, 0.6, 2.6), (-7.6, 0.9, -2.2), WOODC)
    for sz in (-1, 1):
        cyl(0.55, 0.25, (-8.5, 0.55, -2.2 + sz * 0.8), DARK, segs=10, axis='across')
        cyl(0.55, 0.25, (-6.95, 0.55, -2.2 + sz * 0.8), DARK, segs=10, axis='across')
    bar((-7.6, 0.9, -3.5), (-7.6, 0.4, -5.2), 0.15, 0.15, DARK)
    for x, z in ((-7.9, -1.6), (-7.3, -2.7)):
        cyl(0.42, 0.85, (x, 1.2, z), 0xb06041, r2=0.38, segs=8)
    for x, z in ((-5.6, -1.2), (-5.0, -0.4), (-5.5, 0.4)):
        cyl(0.42, 0.85, (x, 0.0, z), 0xb06041, r2=0.38, segs=8)
    # a rank marching out toward the castle, on their stand
    box((6.4 * 0.55, 0.11, 1.2 * 0.55), (-2.2, 0.055, -3.6), 0x6cbf6c)
    for k in range(4):
        knight((-2.2 + (k - 1.5) * 0.83, 0.11, -3.6), BESIEGERS, math.pi / 2)
    ram(8.6, -2.0)
    merge_paint()

# ---- Skyline: the block town round the lap ----

def facing_house(x, z, w, d, h, body, roof, kind, yaw):
    """house() turned about its own centre so its door and gable face
    (cos yaw, -sin yaw): 0 is +X, pi is -X, -pi/2 is +Z; with windows on
    its two sides too, the faces a racer sees looking along the street
    (bare, they read as flat panels)."""
    with transformed((x, 0, z), yaw):
        house(x, z, w, d, h, body, roof, kind)
        rows = [h - 0.55] if h <= 2.4 else [h - 0.55, h - 1.45]
        for sz in (-1, 1):
            zf = z + sz * (d / 2 + 0.01)
            for y in rows:
                for dx in (-w * 0.25, w * 0.25):
                    pts = [(x + dx - 0.2, y - 0.2, zf), (x + dx + 0.2, y - 0.2, zf), (x + dx + 0.2, y + 0.2, zf), (x + dx - 0.2, y + 0.2, zf)]
                    quad(pts if sz > 0 else pts[::-1], 0x8ecae6)

def windows(o, face, half, w, h, cols, rows, y0, glass=0x8ecae6):
    """Rows of windows on `face` of box `o` (its scale applied), `half` out
    from its centre: `cols` across its `w`, `rows` up its `h` from `y0`
    under its centre (o's frame)."""
    for r in range(rows):
        for c in range(cols):
            u = (c + 0.5) / cols * w - w / 2
            v = y0 + (r + 0.5) / rows * h
            face_rect(o, face, half + 0.012, u - 0.17, u + 0.17, v - 0.22, v + 0.22, glass)

def skyscraper(x, z, w, d, h, body, roof, faces, top='slab'):
    """A wooden toy tower block: a tall painted block with rows of windows
    on `faces`, a roof slab (or a stepped crown, or a spire) on top."""
    box((w, h, d), (x, h / 2, z), body)
    o = bpy.context.active_object
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    rows = max(2, int((h - 0.8) / 0.95))
    for f in faces:
        span = d if f in ('+x', '-x') else w
        half = w / 2 if f in ('+x', '-x') else d / 2
        windows(o, f, half, span * 0.86, h - 0.9, max(2, round(span / 0.7)), rows, -h / 2 + 0.35)
    if top == 'slab':
        box((w + 0.2, 0.3, d + 0.2), (x, h + 0.15, z), roof)
    elif top == 'crown':
        box((w * 0.7, 0.8, d * 0.7), (x, h + 0.4, z), roof)
        box((w * 0.4, 0.6, d * 0.4), (x, h + 1.1, z), body)
    else:
        box((w + 0.2, 0.3, d + 0.2), (x, h + 0.15, z), roof)
        cyl(min(w, d) * 0.3, 1.6, (x, h + 0.3, z), roof, r2=0.04, segs=4, yaw=math.pi / 4)

def wooden_tree(x, z, k=1.0):
    cyl(0.14 * k, 0.7 * k, (x, 0, z), 0x9a7b55, segs=6)
    cyl(0.6 * k, 1.5 * k, (x, 0.6 * k, z), 0x6cbf6c, r2=0.05, segs=8)

def traffic_light(x, z, yaw):
    """A toy traffic light on its post, its lamps to (cos yaw, -sin yaw)."""
    box((BAR, 1.6, BAR), (x, 0.8, z), 0x38383d)
    with transformed((x, 0, z), yaw):
        box((0.3, 0.75, 0.3), (x + 0.12, 1.75, z), 0x38383d)
        for k, c in enumerate((0xff5040, 0xf2c14e, 0x6cbf6c)):
            box((0.06, 0.16, 0.16), (x + 0.29, 2.0 - k * 0.24, z), c)

def rug(x0, x1, z0, z1, streets, parks, name):
    """A city play rug lying on the floor: the cream mat with its blue
    border, printed grey streets [(x0, x1, z0, z1)], dashed down their
    middles, and green parks; ONE `floor` part, so the deck's baked shadow
    falls on it and it passes under the road."""
    q = [floor_quad([(x0 - 0.35, z0 - 0.35), (x1 + 0.35, z0 - 0.35), (x1 + 0.35, z1 + 0.35), (x0 - 0.35, z1 + 0.35)], 0.025, 0x5a8fd8),
         floor_quad([(x0, z0), (x1, z0), (x1, z1), (x0, z1)], 0.035, 0xfdf4de)]
    for a0, a1, b0, b1 in streets:
        q.append(floor_quad([(a0, b0), (a1, b0), (a1, b1), (a0, b1)], 0.045, 0x868ba1))
        if a1 - a0 > b1 - b0:                            # dashes down its middle
            m = (b0 + b1) / 2
            for k in range(int((a1 - a0) / 2.2)):
                xa = a0 + 0.6 + k * 2.2
                q.append(floor_quad([(xa, m - 0.08), (xa + 1.0, m - 0.08), (xa + 1.0, m + 0.08), (xa, m + 0.08)], 0.052, 0xfdf4de))
        else:
            m = (a0 + a1) / 2
            for k in range(int((b1 - b0) / 2.2)):
                za = b0 + 0.6 + k * 2.2
                q.append(floor_quad([(m - 0.08, za), (m + 0.08, za), (m + 0.08, za + 1.0), (m - 0.08, za + 1.0)], 0.052, 0xfdf4de))
    for a0, a1, b0, b1 in parks:
        q.append(floor_quad([(a0, b0), (a1, b0), (a1, b1), (a0, b1)], 0.045, 0x6cbf6c))
    group(q, name)

def oval(x0, x1, zc, r, step=0.5):
    """Points round a stadium oval: the near straight at zc - r from x0 to
    x1 heading +X, round the +X end, back along zc + r, round the -X end."""
    pts = []
    L = x1 - x0
    for i in range(int(L / step)):
        pts.append((x0 + i * L / int(L / step), zc - r))
    n = int(math.pi * r / step)
    for i in range(n):
        a = -math.pi / 2 + math.pi * i / n
        pts.append((x1 + r * math.cos(a), zc + r * math.sin(a)))
    for i in range(int(L / step)):
        pts.append((x1 - i * L / int(L / step), zc + r))
    for i in range(n):
        a = math.pi / 2 + math.pi * i / n
        pts.append((x0 + r * math.cos(a), zc + r * math.sin(a)))
    return pts

def wooden_track(pts, w, t):
    """A closed wooden train track along [(x, z)]: a pale beech board `w`
    wide and `t` thick with its two dark grooves on top."""
    n = len(pts)
    def edge(i, off):
        (xa, za), (xb, zb) = pts[(i - 1) % n], pts[(i + 1) % n]
        l = math.hypot(xb - xa, zb - za) or 1.0
        nx, nz = -(zb - za) / l, (xb - xa) / l
        return pts[i][0] + nx * off, pts[i][1] + nz * off
    vs, fs = [], []
    for i in range(n):
        lx, lz = edge(i, w / 2)
        rx, rz = edge(i, -w / 2)
        vs += [(lx, t, lz), (rx, t, rz), (rx, 0.0, rz), (lx, 0.0, lz)]
    for i in range(n):
        a, b = 4 * i, 4 * ((i + 1) % n)
        fs += [(a, b, b + 1, a + 1), (a + 1, b + 1, b + 2, a + 2), (a + 3, a + 0, b + 0, b + 3)]
    me = bpy.data.meshes.new('track')
    me.from_pydata([tuple(P(*v)) for v in vs], [], fs)
    me.update()
    for f in me.polygons:                      # wound to face out and up
        if f.normal.z < -0.5:
            f.flip()
    o = bpy.data.objects.new('track', me)
    bpy.context.scene.collection.objects.link(o)
    paint(o, 0xf2bf99)
    for off in (-w * 0.22, w * 0.22):          # the grooves
        gv, gf = [], []
        for i in range(n):
            ax, az = edge(i, off - 0.05)
            bx, bz = edge(i, off + 0.05)
            gv += [(ax, t + 0.006, az), (bx, t + 0.006, bz)]
        for i in range(n):
            a, b = 2 * i, 2 * ((i + 1) % n)
            gf.append((a, b, b + 1, a + 1))
        me = bpy.data.meshes.new('groove')
        me.from_pydata([tuple(P(*v)) for v in gv], [], gf)
        me.update()
        for f in me.polygons:
            if f.normal.z < 0:
                f.flip()
        g = bpy.data.objects.new('groove', me)
        bpy.context.scene.collection.objects.link(g)
        paint(g, 0x9a7b55)

def train_car(x, y, z, kind, color):
    """A wooden toy train's car standing at (x, y, z), its nose to +X (a
    path traveller faces along its path by its +X): the engine with its
    boiler, cab and funnel, an open wagon of blocks, or a coach."""
    DARK = 0x38383d
    for sx in (-0.42, 0.42):                   # the wheels, either side
        for sz in (-1, 1):
            cyl(0.22, 0.12, (x + sx, y + 0.22, z + sz * 0.33 - 0.06), 0xe66a5a if kind == 'engine' else DARK,
                segs=12, axis='along')
    box((1.3, 0.16, 0.66), (x, y + 0.3, z), 0x9a7b55)                       # the chassis
    if kind == 'engine':
        cyl(0.3, 0.8, (x - 0.1, y + 0.66, z), color, segs=10, axis='across')   # the boiler, along +X
        box((0.5, 0.7, 0.62), (x - 0.35, y + 0.73, z), color)                 # the cab
        box((0.62, 0.12, 0.72), (x - 0.35, y + 1.14, z), 0x38383d)            # its roof
        cyl(0.11, 0.42, (x + 0.48, y + 0.9, z), DARK, r2=0.15, segs=6)        # the funnel
        box((0.12, 0.14, 0.4), (x + 0.68, y + 0.36, z), DARK)                 # the buffer beam
    elif kind == 'wagon':
        box((1.1, 0.42, 0.62), (x, y + 0.59, z), color)
        for k, (dx, c) in enumerate(((-0.25, 0xf2c14e), (0.22, 0x5a8fd8))):
            box((0.36, 0.36, 0.36), (x + dx, y + 0.95, z + (0.06 if k else -0.08)), c, yaw=0.3 * k)
    else:
        box((1.15, 0.62, 0.62), (x, y + 0.69, z), color)
        box((1.25, 0.12, 0.7), (x, y + 1.06, z), 0xfdf4de)
        for dx in (-0.3, 0.05, 0.4):                                         # its windows
            for sz in (-1, 1):
                box((0.24, 0.22, 0.02), (x + dx - 0.06, y + 0.8, z + sz * 0.315), 0x8ecae6)

@piece(1.0)
def block_town():
    # Skyline: the block town the lap runs round, on a city play rug that
    # fills the infield (placed so its frame is the world's, centred on the
    # infield: +X toward the grid straight, +Z toward the top straight).
    # Downtown stands along the skyway's run, tower blocks a child stacked
    # up to the deck's own height, so the skyway rides past their tops; along the south edge a wooden train runs
    # round its oval past the station, the same way the racers go; houses
    # and shops face the grid straight and the top straight across their
    # kerbs, a park lies in the middle and a bus and vans stand in its
    # streets. What faces the roads stands 2 u past the kerb.
    rug(-20.6, 21.9, -18.4, 18.4,
        [(-20.6, 21.9, 0.6, 2.8), (-1.2, 1.0, -18.4, 18.4), (-14.5, -12.5, 2.8, 18.4), (11.4, 13.4, -9.2, 0.6)],
        [(-11.2, -2.6, 4.4, 13.2), (2.6, 11.0, -8.0, -0.6)], 'floor_town')
    # downtown, along the skyway: the front row's west faces 1.6 past its kerb
    for z, w, d, h, body, roof, top in ((-13.2, 2.2, 2.4, 6.4, 0xfdf4de, 0x5a8fd8, 'slab'),
                                        (-9.4, 2.2, 2.6, 7.4, 0x8ecae6, 0xe66a5a, 'crown'),
                                        (-5.2, 2.2, 2.4, 5.6, 0xf2c14e, 0x6cbf6c, 'spire'),
                                        (-1.1, 2.2, 2.6, 7.2, 0xe66a5a, 0xfdf4de, 'slab'),
                                        (4.6, 2.2, 2.4, 6.6, 0xfdf4de, 0xa878e8, 'crown'),
                                        (8.6, 2.2, 2.6, 7.4, 0x5a8fd8, 0xf2c14e, 'slab'),
                                        (12.6, 2.2, 2.2, 5.2, WOOD, 0xe66a5a, 'spire')):
        skyscraper(-19.2, z, w, d, h, body, roof, ('-x', '+z', '-z'), top)
    for z, w, d, h, body, roof, top in ((-7.2, 2.6, 2.4, 5.2, 0x6cbf6c, 0xfdf4de, 'crown'),
                                        (-3.2, 2.4, 2.2, 3.6, 0xfdf4de, 0xe66a5a, 'slab'),
                                        (6.6, 2.4, 2.4, 4.6, 0xe66a5a, 0xf2c14e, 'spire'),
                                        (10.6, 2.6, 2.2, 3.8, 0xa878e8, 0xfdf4de, 'slab')):
        skyscraper(-15.9, z, w, d, h, body, roof, ('-x', '+x', '+z', '-z'), top)
    # the houses facing the grid straight, the gap where the gantry stands
    for z, w, d, h, body, roof, kind in ((-12.2, 2.2, 2.0, 1.8, 0xfdf4de, 0xe66a5a, 'gable'),
                                         (-9.2, 2.4, 2.2, 2.6, 0x8ecae6, 0xf2c14e, 'flat'),
                                         (-1.6, 2.2, 2.0, 1.6, WOOD, 0x6cbf6c, 'gable'),
                                         (1.4, 2.0, 1.8, 2.2, 0xe66a5a, 0xfdf4de, 'flat'),
                                         (4.4, 2.2, 2.0, 1.8, 0xf2c14e, 0x5a8fd8, 'gable'),
                                         (7.4, 2.4, 2.2, 3.0, 0xfdf4de, 0xa878e8, 'pyramid'),
                                         (10.6, 2.2, 2.0, 1.6, 0x6cbf6c, 0xe66a5a, 'gable')):
        facing_house(18.3, z, w, d, h, body, roof, kind, 0.0)
    for z, w, d, h, body, roof, kind in ((-12.0, 2.4, 2.2, 3.4, WOOD, 0xe66a5a, 'flat'),
                                         (-1.0, 2.6, 2.4, 4.2, 0xfdf4de, 0x5a8fd8, 'flat'),
                                         (5.8, 2.4, 2.2, 2.4, 0x8ecae6, 0xe66a5a, 'gable'),
                                         (10.4, 2.4, 2.4, 3.6, 0xf2c14e, 0xfdf4de, 'pyramid')):
        facing_house(15.3, z, w, d, h, body, roof, kind, 0.0)
    # the houses facing the top straight
    for x, w, d, h, body, roof, kind in ((-10.8, 2.2, 2.0, 1.8, 0xe66a5a, 0xfdf4de, 'gable'),
                                         (-7.8, 2.2, 2.2, 2.6, 0xfdf4de, 0x6cbf6c, 'flat'),
                                         (-4.6, 2.2, 2.0, 1.6, 0x5a8fd8, 0xf2c14e, 'gable'),
                                         (2.6, 2.2, 2.2, 2.2, WOOD, 0xe66a5a, 'pyramid'),
                                         (5.8, 2.4, 2.0, 1.8, 0xf2c14e, 0xa878e8, 'gable'),
                                         (9.0, 2.2, 2.2, 2.8, 0x8ecae6, 0xfdf4de, 'flat'),
                                         (12.0, 2.2, 2.0, 1.6, 0xfdf4de, 0xe66a5a, 'gable')):
        facing_house(x, 15.8, w, d, h, body, roof, kind, -math.pi / 2)
    # the park, and the tower a child stacked in it
    for x, z in ((-9.8, 5.6), (-8.0, 11.6), (-4.4, 12.2), (-3.6, 6.0), (-6.4, 8.4), (4.0, -6.6), (9.4, -2.0), (6.2, -1.8)):
        wooden_tree(x, z)
    stack_tower(-7.0, 8.6, (1.3, 1.25, 1.2, 1.15, 1.1, 1.05), (0xe66a5a, WOOD, 0x5a8fd8, 0xf2c14e, 0x6cbf6c, 0xfdf4de), 0xff5040)
    for x, z, yaw in ((1.6, 3.4, 0.0), (-1.8, -0.2, math.pi), (14.9, 1.2, 0.0), (-13.0, 3.4, math.pi)):
        traffic_light(x, z, yaw)
    toy_bus(-6.0, 1.7, NEUTRAL[0], along_x=True)
    toy_van(8.2, 1.7, NEUTRAL[2], along_x=True)
    toy_van(0.0, 10.6, NEUTRAL[1])
    # the toy train's oval along the south edge, the station on its far side
    X0, X1, ZC, R = -13.6, 11.8, -13.8, 3.4
    ring = oval(X0, X1, ZC, R)
    wooden_track(ring, 0.9, 0.12)
    box((8.0, 0.4, 1.4), (-1.0, 0.2, ZC + R + 1.25), 0xb0b6c8)                            # the platform
    facing_house(-1.0, ZC + R + 3.3, 2.0, 4.4, 2.2, 0xe66a5a, 0x5a8fd8, 'gable', math.pi / 2)
    for dx in (-4.2, 2.2):
        box((BAR, 1.8, BAR), (dx, 1.3, ZC + R + 1.25), 0x38383d)
    box((7.0, 0.14, 1.6), (-1.0, 2.25, ZC + R + 1.25), 0x5a8fd8)                          # its canopy
    box((BAR, 1.9, BAR), (X1 + 1.0, 0.95, ZC - R - 1.0), 0x38383d)                        # a signal
    box((0.3, 0.5, 0.3), (X1 + 1.0, 2.1, ZC - R - 1.0), 0x38383d)
    box((0.06, 0.18, 0.18), (X1 + 1.17, 2.2, ZC - R - 1.0), 0x6cbf6c)
    for i, (x, z) in enumerate(ring):
        marker('path_rail_%d' % i, (x, 0.12, z))
    L = sum(math.hypot(ring[(i + 1) % len(ring)][0] - ring[i][0], ring[(i + 1) % len(ring)][1] - ring[i][1]) for i in range(len(ring)))
    x0, z0 = ring[0]
    for k, (kind, c) in enumerate((('coach', 0x5a8fd8), ('wagon', 0x6cbf6c), ('coach', 0xf2c14e), ('engine', 0xe66a5a))):
        with animated('anim_path:c=rail:p=26:f=1:o=%.4f#%d' % (k * 1.45 / L, k), (x0, 0.12, z0)):
            train_car(x0, 0.12, z0, kind, c)
    merge_paint()
    keep_light(0.1)

def toy_bus(x, z, color, along_x=False):
    """A toy town bus, twice a racer's length and taller, its windows in a
    band down both sides: parked in a street it reads as a bus, never a
    rival."""
    def P2(a, b):
        return (x + b, z + a) if along_x else (x + a, z + b)
    for sa in (-1, 1):
        for sb in (-0.65, 0.65):
            px, pz = P2(sa * 0.36, sb)
            toy_wheel(px, pz, 0.15, 0.12, along_x)
    px, pz = P2(0, 0)
    box((2.1, 0.8, 0.74) if along_x else (0.74, 0.8, 2.1), (px, 0.62, pz), color)
    box((1.7, 0.24, 0.76) if along_x else (0.76, 0.24, 1.7), (px, 0.78, pz), 0x8ecae6)
    px, pz = P2(0, 1.06)
    box((0.04, 0.3, 0.6) if along_x else (0.6, 0.3, 0.04), (px, 0.75, pz), 0x8ecae6)

def toy_van(x, z, color, along_x=False):
    """A boxy toy delivery van, taller than a racer, its windscreen to +Z
    (or +X along_x)."""
    def P2(a, b):
        return (x + b, z + a) if along_x else (x + a, z + b)
    for sa in (-1, 1):
        for sb in (-0.4, 0.4):
            px, pz = P2(sa * 0.3, sb)
            toy_wheel(px, pz, 0.14, 0.1, along_x)
    px, pz = P2(0, -0.08)
    box((1.15, 0.7, 0.62) if along_x else (0.62, 0.7, 1.15), (px, 0.55, pz), color)
    px, pz = P2(0, 0.5)
    box((0.04, 0.24, 0.5) if along_x else (0.5, 0.24, 0.04), (px, 0.72, pz), 0x8ecae6)

NEUTRAL = (0xfdf4de, 0xf2bf99, 0x868ba1)   # the town's vehicles: cream, beech, grey, never a racer's livery

def street_strip(rugname, houses, backs, feature):
    """A strip of the city rug with its row of houses facing the road at
    -X (their fronts 2.4 u past the kerb), a second row of taller blocks
    behind and `feature` on the corner of the far cross street."""
    rug(2.6, 12.4, -18.6, 18.4, [(2.6, 12.4, -7.6, -5.4), (2.6, 12.4, 4.4, 6.6)], [(9.6, 12.4, -18.6, -12.6)], rugname)
    for z, w, d, h, body, roof, kind in houses:
        facing_house(6.3, z, w, d, h, body, roof, kind, math.pi)
    for z, w, d, h, body, roof, top in backs:
        skyscraper(9.6, z, w, d, h, body, roof, ('-x', '+z', '-z'), top)
    feature()
    for x, z, yaw in ((4.3, -4.9, math.pi), (4.3, 7.1, math.pi)):
        traffic_light(x, z, yaw)
    toy_van(8.6, -6.5, NEUTRAL[0], along_x=True)
    toy_bus(10.6, 5.5, NEUTRAL[1], along_x=True)
    for x, z in ((10.6, -17.4), (11.4, -14.2), (10.2, -13.6)):
        wooden_tree(x, z)
    merge_paint()
    keep_light(0.1)

def clock_tower():
    box((1.6, 4.8, 1.6), (5.6, 2.4, 3.3), 0xfdf4de)
    box((1.9, 0.3, 1.9), (5.6, 4.95, 3.3), 0xe66a5a)
    cyl(1.15, 1.6, (5.6, 5.1, 3.3), 0x5a8fd8, r2=0.05, segs=4, yaw=math.pi / 4)
    cyl(0.55, 0.06, (4.78, 3.9, 3.3), 0xfdf4de, segs=12, axis='across')
    box((0.04, 0.4, 0.07), (4.73, 4.05, 3.3), 0x2a2735)
    box((0.04, 0.07, 0.3), (4.73, 3.9, 3.42), 0x2a2735)

def water_tower():
    for sx in (-1, 1):
        for sz in (-1, 1):
            box((BAR, 3.0, BAR), (5.6 + sx * 0.6, 1.5, 3.3 + sz * 0.6), 0xb06041)
    cyl(1.05, 1.5, (5.6, 3.0, 3.3), 0xe66a5a, segs=10)
    cyl(1.15, 0.7, (5.6, 4.5, 3.3), 0xfdf4de, r2=0.1, segs=10)

@piece(1.0)
def block_street():
    # Skyline: the town's other side of the grid straight, outside it (placed
    # so its frame is the world's, +X away from the road): a row of houses
    # and shops on its own strip of the city rug facing the racers across
    # the kerb, a second row of taller blocks behind, the cross street where
    # the gantry stands and another further up, a clock tower at the corner,
    # a van and a bus parked down the side streets.
    street_strip('floor_street',
                 ((-17.0, 2.2, 2.0, 1.8, 0xf2c14e, 0xe66a5a, 'gable'), (-14.0, 2.4, 2.2, 2.4, 0xfdf4de, 0x5a8fd8, 'flat'),
                  (-11.0, 2.2, 2.0, 1.6, 0x6cbf6c, 0xfdf4de, 'gable'), (-8.6, 2.0, 1.6, 2.0, 0xe66a5a, 0xf2c14e, 'pyramid'),
                  (-3.6, 2.2, 2.0, 1.8, WOOD, 0xe66a5a, 'gable'), (-0.6, 2.4, 2.2, 2.8, 0x8ecae6, 0xfdf4de, 'flat'),
                  (8.6, 2.2, 2.0, 2.2, 0x5a8fd8, 0xf2c14e, 'gable'), (11.6, 2.4, 2.2, 1.8, 0xf2c14e, 0xa878e8, 'flat'),
                  (14.6, 2.2, 2.0, 2.6, 0xe66a5a, 0xfdf4de, 'pyramid'), (17.4, 2.0, 1.8, 1.6, 0xfdf4de, 0x5a8fd8, 'gable')),
                 ((-15.6, 2.4, 2.6, 4.6, 0xfdf4de, 0xe66a5a, 'slab'), (-10.6, 2.4, 2.4, 3.6, 0x5a8fd8, 0xfdf4de, 'crown'),
                  (-1.8, 2.6, 2.6, 5.4, 0xf2c14e, 0x6cbf6c, 'slab'), (9.8, 2.4, 2.4, 4.2, 0xe66a5a, 0x5a8fd8, 'spire'),
                  (15.6, 2.4, 2.6, 3.8, WOOD, 0xe66a5a, 'slab')),
                 clock_tower)

@piece(1.0)
def block_street_west():
    # Skyline: another street of the town outside the south-bound leg past
    # the toy loop (placed like block_street, +X away from the road): its
    # own row of houses facing the racers, taller blocks behind and the
    # town's water tower on the far corner.
    street_strip('floor_street_west',
                 ((-17.2, 2.2, 2.0, 2.2, 0x5a8fd8, 0xfdf4de, 'flat'), (-14.2, 2.2, 2.0, 1.6, 0xfdf4de, 0xe66a5a, 'gable'),
                  (-11.2, 2.4, 2.2, 2.6, WOOD, 0x6cbf6c, 'pyramid'), (-8.6, 2.0, 1.8, 1.8, 0xe66a5a, 0xfdf4de, 'gable'),
                  (-3.6, 2.4, 2.2, 2.4, 0xf2c14e, 0x5a8fd8, 'flat'), (-0.6, 2.2, 2.0, 1.6, 0x6cbf6c, 0xe66a5a, 'gable'),
                  (8.6, 2.4, 2.2, 2.8, 0xfdf4de, 0xa878e8, 'pyramid'), (11.6, 2.2, 2.0, 1.8, 0x8ecae6, 0xe66a5a, 'gable'),
                  (14.6, 2.2, 2.0, 2.2, 0xe66a5a, 0xf2c14e, 'flat'), (17.4, 2.0, 1.8, 1.6, WOOD, 0x5a8fd8, 'gable')),
                 ((-15.6, 2.4, 2.4, 3.8, 0x8ecae6, 0xfdf4de, 'crown'), (-10.6, 2.6, 2.6, 5.0, 0xe66a5a, 0xf2c14e, 'slab'),
                  (-1.8, 2.4, 2.4, 4.2, 0xfdf4de, 0x5a8fd8, 'spire'), (9.8, 2.6, 2.6, 5.2, 0xf2c14e, 0xe66a5a, 'slab'),
                  (15.6, 2.4, 2.4, 3.6, 0x6cbf6c, 0xfdf4de, 'slab')),
                 water_tower)

def tv_tower(x, z):
    """The town's TV tower, stacked by a child out of the blocks: a shaft of
    blocks narrowing upward, the round pod with its band of windows a storey
    over the skyway's U, a cap and the red and white mast."""
    y = 0.0
    for k, sz in enumerate((1.4, 1.3, 1.2, 1.1, 1.0, 0.95, 0.9, 0.85)):
        box((sz, sz, sz), (x, y + sz / 2, z), (0x5a8fd8, WOOD, 0xe66a5a, 0xf2c14e, 0x6cbf6c, 0xfdf4de, 0x5a8fd8, 0xe66a5a)[k],
            yaw=0.12 * ((k * 5) % 3 - 1))
        y += sz
    cyl(1.0, 0.4, (x, y, z), 0xfdf4de, r2=1.7, segs=12)                     # the pod's underside
    cyl(1.7, 1.3, (x, y + 0.4, z), 0x5a8fd8, segs=12)                       # the pod
    cyl(1.72, 0.45, (x, y + 0.85, z), 0x8ecae6, segs=12)                    # its band of windows
    cyl(1.7, 0.5, (x, y + 1.7, z), 0xfdf4de, r2=0.6, segs=12)               # its cap
    for k in range(6):                                                     # the mast, red and white
        box((0.45, 0.7, 0.45), (x, y + 2.55 + k * 0.7, z), (0xe66a5a, 0xfdf4de)[k % 2])

def toy_truck(x, z, color, yaw):
    """A toy dump truck the racers' size, its cab to (cos yaw, -sin yaw), its
    bed tipped up a little with a load of blocks."""
    with transformed((x, 0, z), yaw):
        for sx in (-0.45, 0.4):
            for sz in (-1, 1):
                cyl(0.2, 0.14, (x + sx, 0.2, z + sz * 0.3 - 0.07), 0x2a2735, segs=12, axis='along')
        box((1.5, 0.16, 0.6), (x, 0.3, z), 0x555b66)
        box((0.45, 0.45, 0.6), (x + 0.5, 0.6, z), color)                          # the cab
        box((0.06, 0.2, 0.44), (x + 0.73, 0.68, z), 0x8ecae6)
        box((0.9, 0.36, 0.64), (x - 0.25, 0.62, z), 0xf2c14e, roll=0.18)           # the bed
        for k, (dx, c) in enumerate(((-0.45, 0xe66a5a), (-0.1, 0x5a8fd8))):
            box((0.3, 0.3, 0.3), (x + dx, 0.95 - 0.06 * k, z + 0.08 * (k - 0.5)), c, yaw=0.4 * k)

@piece(1.0)
def block_westside():
    # Skyline: the town's west side, across the approach from downtown, so
    # the skyway rides over a street with blocks on both sides of it (placed
    # so its frame is the world's turned to face the approach, +X toward
    # it): a row of houses and tower blocks on its strip of rug, their
    # fronts 2.2 u past the approach's kerb and their backs to the dive and
    # the toy loop, a tower a child stacked to the skyway's height at its
    # north end where the U turns round it, and at its south end the
    # building site where the town is still going up: an unfinished block
    # with its corner columns and first floor, piles of blocks, a dump truck
    # and the crane slewing over it by the south-bound leg.
    rug(-11.0, 5.9, -23.4, -7.6, [(-11.0, 5.9, -9.2, -7.6)], [], 'floor_site')
    rug(-2.6, 5.9, -7.6, 24.6, [(-2.6, 5.9, 9.4, 11.4)], [], 'floor_west')
    for z, w, d, h, body, roof, kind in ((-5.6, 2.2, 2.0, 1.8, 0xfdf4de, 0xe66a5a, 'gable'),
                                         (-2.6, 2.4, 2.2, 2.6, 0x5a8fd8, 0xf2c14e, 'flat'),
                                         (3.4, 2.2, 2.2, 2.2, 0xe66a5a, 0xfdf4de, 'pyramid'),
                                         (6.6, 2.4, 2.2, 2.8, 0xfdf4de, 0xa878e8, 'flat'),
                                         (13.6, 2.2, 2.0, 1.8, WOOD, 0x5a8fd8, 'gable'),
                                         (16.6, 2.4, 2.0, 2.4, 0x6cbf6c, 0xfdf4de, 'flat'),
                                         (19.6, 2.2, 2.2, 1.6, 0xfdf4de, 0xe66a5a, 'gable')):
        facing_house(2.4, z, w, d, h, body, roof, kind, 0.0)
    for z, w, d, h, body, roof, top in ((-3.6, 2.2, 2.4, 4.8, 0xe66a5a, 0xfdf4de, 'slab'),
                                        (2.2, 2.2, 2.6, 6.2, 0x8ecae6, 0xf2c14e, 'crown'),
                                        (14.8, 2.2, 2.4, 5.4, 0xf2c14e, 0x5a8fd8, 'spire'),
                                        (19.8, 2.2, 2.4, 4.2, 0xfdf4de, 0x6cbf6c, 'slab')):
        skyscraper(-0.4, z, w, d, h, body, roof, ('+x', '-x', '+z', '-z'), top)
    # the first house the racers pass under the skyway: a one-storey
    # cottage set back behind its front garden, so the street opens there
    # instead of a wall swiping past the camera
    facing_house(1.0, 0.0, 1.8, 1.6, 1.3, 0xf2c14e, 0x6cbf6c, 'gable', 0.0)
    for z in (-0.6, 0.7):
        wooden_tree(3.0, z, 0.8)
    tv_tower(0.6, 23.2)
    for x, z, yaw in ((4.4, 8.6, 0.0), (4.4, 12.2, 0.0)):
        traffic_light(x, z, yaw)
    toy_van(0.6, 10.4, NEUTRAL[0], along_x=True)
    # the building site: the unfinished block, its four corner columns of
    # blocks two high and its first floor on them, the blocks for the next
    # stacked by it, a truck bringing more and the crane over it all
    UX, UZ, UW = 1.6, -15.4, 3.2
    for sx in (-1, 1):
        for sz in (-1, 1):
            for j in range(2):
                box((0.8, 0.8, 0.8), (UX + sx * (UW / 2 - 0.4), 0.4 + j * 0.8, UZ + sz * (UW / 2 - 0.4)), TOY[(j + sx + sz + 2) % 4])
    box((UW + 0.2, 0.3, UW + 0.2), (UX, 1.75, UZ), 0xfdf4de)
    for sx in (-1, 1):
        box((0.8, 0.8, 0.8), (UX + sx * (UW / 2 - 0.4), 2.3, UZ - (UW / 2 - 0.4)), TOY[(sx + 1) % 4])
    for k, (x, z, c) in enumerate(((-2.4, -19.8, 0xe66a5a), (-1.5, -19.9, WOOD), (-2.0, -19.0, 0x5a8fd8),
                                   (-1.4, -18.9, 0xf2c14e), (-2.0, -19.4, 0x6cbf6c))):
        box((0.85, 0.85, 0.85), (x, 0.42 + (0.85 if k == 4 else 0.0), z), c, yaw=0.25 * k)
    toy_truck(-4.6, -12.6, NEUTRAL[0], 2.4)
    toy_crane(-6.4, -17.2, 5.0, 0.0, tag='#site', p=14, turn=-math.pi / 2)       # its jib away from the road
    merge_paint()
    keep_light(0.1)


@piece(1.0)
def barbican():
    # Gauntlet: the castle's barbican, its covered outer passage, astride the
    # run out east of the plunge (placed at lat 0: x = 0 is the centreline,
    # +Z the way the racers drive): four arches of the castle's blocks,
    # three high on each side of the road (their inner faces 4 u off the
    # centreline, past the road's margin), a long plank across each and the
    # roof of planks laid along them, crenels down both its edges and a
    # pennant at each end. Its underside stands 4.1 over the floor, past
    # spotIssue's OVER_GAP and the highest camera: the racers drive through
    # its shade. Built from the castle gate's blocks.
    S, H = 1.2, 3                                           # a column's block, its height in blocks
    XI = 4.0 + S / 2                                         # the columns' centres off the centreline
    ZS = (-5.25, -1.75, 1.75, 5.25)                          # the arches along the road
    for k, z in enumerate(ZS):
        for sx in (-1, 1):
            face = '-x' if sx > 0 else '+x'                  # the face turned to the road
            for j in range(H):
                block(S, (sx * XI, S / 2 + j * S, z), TOY[(j + k + (sx > 0)) % 4], faces=(face, '+z', '-z'),
                      letters={face: ABC[(3 * j + 2 * k + (sx > 0)) % 8]} if (j + k) % 2 == 0 else None)
        box((2 * XI + S + 0.4, 0.5, S), (0, H * S + 0.25, z), WOOD)                  # the plank across
    LZ = ZS[-1] - ZS[0] + S + 1.0
    RY = H * S + 0.5
    for i in range(4):                                                               # the roof's planks
        box((2.6, 0.3, LZ), (-3.9 + i * 2.6, RY + 0.15, 0), (WOOD, 0xe8b48a)[i % 2])
    for sx in (-1, 1):                                                               # crenels down its edges
        for i in range(6):
            box((0.6, 0.55, 0.6), (sx * (XI + 0.5), RY + 0.3 + 0.27, -LZ / 2 + 0.6 + i * (LZ - 1.2) / 5), 0xf2c14e)
    for n, z in enumerate((-LZ / 2 + 0.6, LZ / 2 - 0.6)):                            # a pennant at each end
        box((BAR * 1.4, 1.8, BAR * 1.4), (-(XI + 0.5), RY + 0.3 + 0.9, z), 0x2a2735)
        with animated('anim_sway:a=x:d=24:p=%.1f#%d' % (1.8 + 0.3 * n, n), (-(XI + 0.5), RY + 0.3 + 1.75, z)):
            box((0.08, 0.8, 1.2), (-(XI + 0.5), RY + 0.3 + 1.35, z + 0.65), 0xff5040)
            box((0.08, 0.44, 0.6), (-(XI + 0.5), RY + 0.3 + 1.35, z + 1.5), 0xff5040)
    merge_paint()


def toy_cannon(x, z, color):
    """A toy cannon on its wheeled carriage, its barrel to +X."""
    for sz in (-1, 1):
        cyl(0.6, 0.2, (x, 0.6, z + sz * 0.55 - (0.2 if sz < 0 else 0.0)), 0x7a5a3a, segs=10, axis='along')
        cyl(0.22, 0.26, (x, 0.6, z + sz * 0.62 - (0.26 if sz < 0 else 0.0)), 0xf2c14e, segs=6, axis='along')
    box((1.4, 0.45, 0.8), (x - 0.1, 0.75, z), color)                              # the carriage
    bar((x - 0.6, 0.7, z), (x - 1.7, 0.12, z), 0.4, 0.3, color)                   # its trail on the floor
    cyl(0.34, 2.0, (x - 0.7, 1.15, z), 0x38383d, r2=0.27, segs=8, axis='across')  # the barrel
    cyl(0.36, 0.18, (x + 1.15, 1.15, z), 0x38383d, segs=8, axis='across')         # its muzzle ring

@piece(1.0)
def cannon_battery():
    # Gauntlet: the besiegers' guns, run out along the leg the racers come
    # down after the barbican (placed on its outside, +X to the road): three
    # toy cannons in the red side's colours aimed across the road at the
    # castle, so the race runs the gauntlet between the castle's knights and
    # the guns; barrels of powder and a pyramid of shot by them, a red rank
    # of gunners behind, a red flag on its pole at the battery's end, and
    # down the leg to the corner the gunners' tents, powder cart and wagon.
    for k, z in enumerate((-5.0, 0.0, 5.0)):
        toy_cannon(0.0, z, (0xe66a5a, 0xc8955a, 0xe66a5a)[k])
    for x, z in ((-1.6, -2.6), (-1.1, -2.2), (-1.5, 2.6)):
        cyl(0.36, 0.75, (x, 0.0, z), 0xb06041, r2=0.32, segs=8)
    for x, y, z in ((-0.6, 0.0, 2.3), (-0.6, 0.0, 2.9), (-1.1, 0.0, 2.6), (-0.8, 0.42, 2.6)):
        box((0.42, 0.42, 0.42), (x, y + 0.21, z), 0x38383d)
    box((6.4 * 0.55, 0.11, 1.2 * 0.55), (-3.2, 0.055, 0.0), 0x6cbf6c, yaw=math.pi / 2)
    for k in range(4):
        knight((-3.2, 0.11, (k - 1.5) * 0.83), BESIEGERS, 0.0)
    # the gunners' tents and the powder cart down the leg, toward the corner
    pavilion(-0.8, 9.4, 1.2, 1.4, 0xff5040, 0xff5040)
    pavilion(-1.6, 12.4, 1.1, 1.3, 0xf2c14e, 0xff5040)
    pavilion(-0.4, 15.4, 1.2, 1.4, 0xff5040, 0xf2c14e)
    box((1.4, 0.55, 2.2), (-2.6, 0.85, 16.2), 0xc8955a)                      # a supply wagon, its barrels
    for sz in (-1, 1):
        for x0 in (-3.52, -1.68):
            cyl(0.5, 0.22, (x0, 0.5, 16.2 + sz * 0.7), 0x7a5a3a, segs=10, axis='across')
    for dz in (-0.5, 0.5):
        cyl(0.36, 0.75, (-2.6, 1.12, 16.2 + dz), 0xb06041, r2=0.32, segs=8)
    box((1.0, 0.5, 1.6), (0.6, 0.65, 10.9), 0xc8955a)
    for sz in (-1, 1):
        cyl(0.4, 0.2, (0.6, 0.4, 10.9 + sz * 0.55 - (0.2 if sz < 0 else 0.0)), 0x7a5a3a, segs=10, axis='along')
    for dz in (-0.35, 0.35):
        cyl(0.3, 0.6, (0.6, 0.9, 10.9 + dz), 0xb06041, r2=0.27, segs=8)
    box((BAR * 1.4, 3.4, BAR * 1.4), (-1.6, 1.7, -7.0), 0x2a2735)
    with animated('anim_sway:a=x:d=22:p=2.2#flag', (-1.6, 3.35, -7.0)):
        box((0.08, 0.9, 1.4), (-1.6, 2.85, -6.25), 0xff5040)
        box((0.08, 0.5, 0.7), (-1.6, 2.85, -5.2), 0xff5040)
    merge_paint()


def shop(x, z, w, d, h, body, awning, sign):
    """A wooden toy shop facing +X: its block, a door and a wide window, a
    striped awning sloping out over them and its sign board over that."""
    box((w, h, d), (x, h / 2, z), body)
    plate_x(x + w / 2 + 0.01, 0, 0.75, z + d * 0.18 - 0.22, z + d * 0.18 + 0.22, 0x3a2a22)
    plate_x(x + w / 2 + 0.01, 0.3, 0.85, z - d * 0.42, z - d * 0.02, 0x8ecae6)
    n = max(2, round(d / 0.5))
    for k in range(n):                                       # the awning's stripes
        zz = z - d / 2 + (k + 0.5) * d / n
        box((0.9, 0.08, d / n), (x + w / 2 + 0.38, 1.12, zz), awning if k % 2 == 0 else 0xfdf4de, roll=-0.35)
    box((0.1, 0.42, d * 0.8), (x + w / 2 + 0.06, h - 0.35 if h > 1.8 else 1.5, z), sign)
    box((w + 0.16, 0.22, d + 0.16), (x, h + 0.11, z), 0xfdf4de)

def fire_engine(x, z, yaw):
    """A toy fire engine, its cab to (cos yaw, -sin yaw)."""
    with transformed((x, 0, z), yaw):
        for sx in (-0.5, 0.45):
            for sz in (-1, 1):
                cyl(0.2, 0.14, (x + sx, 0.2, z + sz * 0.32 - 0.07), 0x2a2735, segs=12, axis='along')
        box((1.6, 0.5, 0.62), (x, 0.5, z), 0xe66a5a)
        box((0.5, 0.36, 0.62), (x + 0.55, 0.93, z), 0xe66a5a)
        box((0.06, 0.2, 0.46), (x + 0.81, 0.95, z), 0x8ecae6)
        box((1.0, 0.1, 0.24), (x - 0.25, 0.86, z), 0xfdf4de)          # the ladder
        box((0.16, 0.12, 0.3), (x + 0.55, 1.17, z), 0x5a8fd8)          # the lamp

@piece(1.0)
def block_high_street():
    # Skyline: the town's shops along the south edge, outside it across the
    # road from the station and the train (placed on its outside, +X to the
    # road): a row of toy shops with striped awnings and sign boards on
    # their strip of the city rug, fronts 1.5 u past the kerb, the fire
    # station with its engine out front at the street's middle, office
    # blocks behind, a bus and delivery vans at one end.
    rug(-4.2, 7.0, -22.6, 22.6, [(-4.2, 7.0, -1.4, 1.4), (-4.2, -2.2, -22.6, 22.6)], [], 'floor_shops')
    shops = ((-20.6, 2.0, 0xfdf4de, 0xe66a5a, 0x5a8fd8), (-18.0, 2.4, 0xf2c14e, 0x5a8fd8, 0xe66a5a),
             (-15.4, 1.8, 0x8ecae6, 0xe66a5a, 0xf2c14e), (-12.8, 2.6, 0xe66a5a, 0x6cbf6c, 0xfdf4de),
             (-10.2, 2.0, WOOD, 0x5a8fd8, 0x6cbf6c), (-7.6, 2.2, 0xfdf4de, 0xa878e8, 0xe66a5a),
             (-5.0, 1.8, 0x6cbf6c, 0xe66a5a, 0xf2c14e),
             (5.0, 2.2, 0xf2c14e, 0xe66a5a, 0x5a8fd8), (7.6, 1.8, 0xfdf4de, 0x6cbf6c, 0xe66a5a),
             (10.2, 2.4, 0x5a8fd8, 0xf2c14e, 0xfdf4de), (12.8, 2.0, 0xe66a5a, 0x5a8fd8, 0xf2c14e))
    for z, h, body, awning, sign in shops:
        shop(3.8, z, 2.0, 2.4, h, body, awning, sign)
    # the fire station: a red block with three dark doors, a tower for its
    # hoses, the engine parked out front
    box((2.8, 2.4, 4.6), (3.2, 1.2, 0.0), 0xe66a5a)
    for dz in (-1.4, 0.0, 1.4):
        plate_x(4.61, 0.0, 1.5, dz - 0.5, dz + 0.5, 0x3a2a22)
    box((3.0, 0.26, 4.8), (3.2, 2.53, 0.0), 0xfdf4de)
    box((1.4, 4.2, 1.4), (2.4, 2.1, -2.9), 0xe66a5a)
    box((1.6, 0.26, 1.6), (2.4, 4.33, -2.9), 0xfdf4de)
    fire_engine(4.9, 1.0, 0.0)
    # office blocks behind the shops
    for z, w, d, h, body, roof, top in ((-19.0, 2.4, 2.6, 4.4, 0x8ecae6, 0xe66a5a, 'slab'),
                                        (-13.6, 2.4, 2.4, 5.6, 0xfdf4de, 0x5a8fd8, 'crown'),
                                        (-8.2, 2.2, 2.4, 3.8, 0xf2c14e, 0x6cbf6c, 'slab'),
                                        (7.2, 2.4, 2.6, 5.0, 0xe66a5a, 0xfdf4de, 'spire'),
                                        (12.4, 2.2, 2.4, 4.0, WOOD, 0x5a8fd8, 'slab')):
        skyscraper(0.2, z, w, d, h, body, roof, ('+x', '+z', '-z'), top)
    # the bus and the vans at the street's east end, back from the kerb
    toy_bus(2.0, 16.6, NEUTRAL[0])
    toy_van(0.4, 15.8, NEUTRAL[1])
    toy_van(0.4, 18.2, NEUTRAL[2])
    for x, z in ((-2.0, 17.0), (-1.6, 19.6), (-2.2, 21.4)):
        wooden_tree(x, z)
    traffic_light(4.6, -1.8, 0.0)
    merge_paint()
    keep_light(0.1)


@piece(1.0)
def castle_watchtower():
    # Gauntlet: the castle's watchtower over the bridge out of the plunge,
    # outside it (+X to the road): one tall tower of the fortress's big
    # blocks, four high under its cone roof and red pennant, so it stands in
    # the wide view the racers get coming down the plunge; a stub of
    # crenellated wall either side, two of the castle's blue knights at its
    # foot and their cannon run out toward the road.
    T = 1.8
    block_tower(0.0, 0.0, T, 4, 1, 0x5a8fd8, '+x', pennant='anim_sway:a=x:d=24:p=1.9#watch', fly=-1)
    for sz in (-1, 1):
        block_run((0.0, sz * (T / 2)), (0.0, sz * (T / 2 + 3.9)), 0.0, 1 if sz > 0 else 3, faces=('+x', '+y'), crenels=True)
    for z in (-2.8, 2.8):
        knight((1.4, 0.0, z), DEFENDERS, 0.0)
    toy_cannon(2.2, 0.2, 0x5a8fd8)
    merge_paint()


@piece(1.0)
def block_uptown():
    # Skyline: the town's tallest blocks beside the skyway where it turns
    # for the U, north of the top straight (placed so its frame is the
    # world's): three tower blocks on their own rug, standing a storey or
    # two over the deck, so the racers up on the skyway see a downtown
    # beside them over its kerb, not the top of a lone stack far below it;
    # windows on every face, a water tank on the tallest.
    rug(-2.8, 4.8, -4.8, 4.8, [(-2.8, 4.8, -0.9, 0.9)], [], 'floor_uptown')
    skyscraper(-1.2, -2.6, 2.2, 2.4, 9.6, 0xfdf4de, 0x5a8fd8, ('+x', '-x', '+z', '-z'), 'crown')
    skyscraper(-1.2, 2.6, 2.2, 2.4, 10.6, 0xe66a5a, 0xfdf4de, ('+x', '-x', '+z', '-z'), 'slab')
    cyl(0.55, 0.8, (-1.2, 10.9, 2.6), 0xb06041, segs=10)
    cyl(0.6, 0.35, (-1.2, 11.7, 2.6), 0xfdf4de, r2=0.1, segs=10)
    skyscraper(2.6, 0.0, 2.4, 2.6, 8.4, 0xf2c14e, 0x6cbf6c, ('+x', '-x', '+z', '-z'), 'spire')
    merge_paint()
    keep_light(0.1)


# ---- round 6: Skysnake's sky snake and dice, Gauntlet's ram ----

def slab_on(top, t, color):
    """A board `t` thick under its four top corners [(x, y, z)] (around,
    seen from above), its sides straight down: a sloped, tilted plank."""
    vs = [tuple(P(*v)) for v in top] + [tuple(P(v[0], v[1] - t, v[2])) for v in top]
    fs = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    me = bpy.data.meshes.new('slab')
    me.from_pydata(vs, [], fs)
    me.update()
    o = bpy.data.objects.new('slab', me)
    bpy.context.scene.collection.objects.link(o)
    if o.data.polygons[0].normal.z < 0:
        for f in o.data.polygons:
            f.flip()
    return paint(o, color)

@piece(1.0)
def sky_snake():
    # Skysnake's hero, at the inside of the sky weave's first bend: the
    # board's wooden snakes' big sibling, a jointed toy snake of the same green and yellow blocks
    # rising out of a round woven basket, its body coiled up the snake
    # charmer's way to its head just over the spiral's top deck, the head
    # swaying slowly side to side as the racers pass it, its face to the
    # road (+X).
    R, H = 2.0, 2.0
    cyl(R, H, (0, 0, 0), 0xd8a878, segs=14)                                  # the basket
    for y in (0.45, 0.95, 1.45):                                           # its woven bands
        torus(R + 0.03, 0.09, (0, y, 0), 0xb06041, segs=14)
    for k in range(14):                                                    # and the wicker ribs between them
        a = (k + 0.5) * 2 * math.pi / 14
        box((0.1, H - 0.1, 0.16), (math.cos(a) * (R + 0.02), H / 2, math.sin(a) * (R + 0.02)), 0x9a7b55, yaw=-a)
    torus(R + 0.05, 0.16, (0, H, 0), 0x9a7b55, segs=14)                       # its rim
    cyl(R - 0.15, 0.05, (0, H - 0.08, 0), 0x3a2a22, segs=14)                  # the dark inside
    # the coil: blocks along a rising, narrowing helix, tapering to the neck
    pts = []
    N = 22
    for i in range(N + 1):
        f = i / N
        a = 2 * math.pi * 1.5 * f
        r = 1.25 - 0.55 * f
        pts.append((r * math.cos(a), H + 0.3 + 3.4 * f, r * math.sin(a)))
    for i in range(N):
        (x0, y0, z0), (x1, y1, z1) = pts[i], pts[i + 1]
        g = 0.12
        k = 1.0 - 0.3 * i / N
        bar((x0 + (x1 - x0) * g, y0 + (y1 - y0) * g, z0 + (z1 - z0) * g),
            (x1 - (x1 - x0) * g, y1 - (y1 - y0) * g, z1 - (z1 - z0) * g), 0.85 * k, 0.75 * k, SNAKE[i % 2])
    nx, ny, nz = pts[-1]
    with animated('anim_sway:a=y:d=35:p=7#head', (nx, ny, nz)):
        for i, (h0, a0, h1, a1) in enumerate(((0.0, 0.0, 0.25, 0.55), (0.25, 0.55, 0.65, 0.95))):
            bar((nx + h0, ny + a0, nz), (nx + h1, ny + a1, nz), 0.62, 0.58, SNAKE[(N + i) % 2])
        hx, hy = nx + 1.05, ny + 1.05
        box((0.95, 0.72, 1.25), (hx, hy, nz), 0x6cbf6c, yaw=math.pi / 2)        # the head, to +X
        box((0.8, 0.2, 1.05), (hx + 0.08, hy - 0.4, nz), 0xf2c14e, yaw=math.pi / 2)
        for sd in (-1, 1):
            box((0.28, 0.28, 0.28), (hx + 0.15, hy + 0.3, nz + sd * 0.4), 0xfdf4de)
            box((0.12, 0.16, 0.16), (hx + 0.26, hy + 0.32, nz + sd * 0.47), 0x2a2735)
        bar((hx + 0.62, hy - 0.22, nz), (hx + 1.15, hy - 0.28, nz), 0.12, 0.07, 0xff5040)

def round_die(x, y, z, s, yaw, body, pip, faces):
    """A soft foam die `s` a side standing at (x, y, z), turned `yaw`, its
    round pips on the four sides named in `faces` [(face, n)]."""
    with transformed((x, 0, z), yaw):
        box((s, s, s), (x, y + s / 2, z), body)
        for face, n in faces:
            nrm, right = FACES[face]
            for u, v in PIP[n]:
                cx = x + nrm[0] * s / 2 + right[0] * u * 0.27 * s
                cz = z + nrm[2] * s / 2 + right[2] * u * 0.27 * s
                cy = y + s / 2 + v * 0.27 * s
                h = 0.06
                if face in ('+x', '-x'):
                    cyl(0.11 * s, h, (cx - (h if face == '-x' else 0.0) + (-0.01 if face == '+x' else 0.01), cy, cz), pip, segs=8, axis='across')
                else:
                    cyl(0.11 * s, h, (cx, cy, cz - (h if face == '-z' else 0.0) + (-0.01 if face == '+z' else 0.01)), pip, segs=8, axis='along')

@piece(1.0)
def dice_tower():
    # Skysnake: a slalom gate in the sky, the floor mat's own soft foam dice,
    # cream with round red and blue pips, stacked four high by a child, one
    # of the game's big pawns on top, so two dice and the pawn stand over
    # the deck the road weaves round.
    S = 2.0
    y = 0.0
    for k, (yaw, p) in enumerate(((0.15, 0xe66a5a), (-0.25, 0x5a8fd8), (0.4, 0xe66a5a), (-0.1, 0x5a8fd8))):
        round_die(0, y, 0, S, yaw, 0xfdf4de, p,
                  (('+x', (5, 3, 6, 2)[k]), ('-z', (2, 4, 1, 5)[k]), ('+z', (3, 6, 4, 1)[k]), ('-x', (4, 1, 2, 6)[k])))
        y += S
    pawn((0, y, 0), 0xf2c14e, k=0.9)
    merge_paint()

@piece(1.0)
def snake_ladder():
    # Skysnake: the game's ladder made a toy, up the outside of the spiral
    # climb. Its feet on the floor outside the low road, it leans in (+X, at
    # the eye) over that road onto the top deck's outer kerb, the climb the
    # racers drive made the move up a ladder, one of the board's pawns
    # partway up it. Placed at the foot (lat 6.5 at u 0.4775), where the top
    # deck's kerb edge stands REACH in and KERB up.
    REACH, KERB, BROWN = 3.96, 5.45, 0xb06041
    T, HALF = 0.28, 0.72                          # a rail's side; the rails' centres off the middle
    a = math.atan2(KERB + T / 2, REACH)           # the rails' underside on the kerb's edge
    C = math.hypot(REACH, KERB + T / 2)           # along a rail to the kerb's edge
    L = C + 0.35                                  # its ends just past it (longer, they stood over the kerb as a hurdle)
    ca, sa = math.cos(a), math.sin(a)
    def at(d, z=0.0):
        return (d * ca, T / 2 + d * sa, z)
    for z in (-HALF, HALF):
        strut(at(0.0, z), at(L, z), T, BROWN)
    RUNG = [0.55 + (C - 0.95) * k / 8 for k in range(9)]   # nine rungs, about a racer's wheel apart, the top one under the kerb
    for d in RUNG:
        x, y, _ = at(d)
        cyl(0.11, 2 * HALF, (x, y, -HALF), CREAM, axis='along')
    x, y, _ = at(RUNG[3])                         # a red pawn on the fourth, climbing
    pawn((x - 0.05, y + 0.1, 0), 0xe66a5a, k=0.6)
    merge_paint()

@piece(1.0)
def siege_ram():
    # Gauntlet: the besiegers' battering ram rolled into the corner after
    # their guns, aimed across the infield at the castle (-Z), its log
    # swinging slowly back and forth on its slings, and a red rank of the
    # besiegers marching beside it on their stand.
    ram(0.0, 0.0, swing='anim_sway:a=x:d=10:p=3.4#log')
    box((1.2 * 0.55, 0.11, 6.4 * 0.55), (-2.4, 0.055, 0.2), 0x6cbf6c)
    for k in range(4):
        knight((-2.4, 0.11, 0.2 + (k - 1.5) * 0.83), BESIEGERS, math.pi / 2)
    merge_paint()

# ---- round 9: Gauntlet's tourney (the lists, the camp, what lies about the floor) ----

def shield(x, y, z, color, yaw=0.0):
    """A toy knight's shield hung at (x, y, z), its face to (cos yaw, -sin
    yaw): the side's colour, a cream cross standing proud of it."""
    with transformed((x, 0, z), yaw):
        box((0.1, 0.62, 0.5), (x, y, z), color)
        box((0.06, 0.5, 0.12), (x + 0.07, y, z), 0xfdf4de)
        box((0.06, 0.12, 0.4), (x + 0.07, y + 0.06, z), 0xfdf4de)

def shield_rack(x, z, colors, yaw=0.0):
    """A rail on two posts with the knights' shields hung on it, faces to
    (cos yaw, -sin yaw), and two spears leant on its end."""
    WOODC = 0x9a7b55
    n = len(colors)
    half = 0.36 * n + 0.1
    with transformed((x, 0, z), yaw):
        for s in (-1, 1):
            box((0.14, 1.0, 0.14), (x, 0.5, z + s * half), WOODC)
        box((0.12, 0.12, 2 * half + 0.3), (x, 0.96, z), WOODC)
        for k, c in enumerate(colors):
            shield(x + 0.12, 0.62, z + (k - (n - 1) / 2) * 0.72, c)
        for k in (0, 1):
            bar((x - 0.5 - 0.2 * k, 0.0, z + half + 0.25), (x - 0.02, 1.9, z + half + 0.2), 0.08, 0.08, 0xc8955a)

def archery_butt(x, z, yaw=0.0):
    """A straw archery target on its easel, its face to (cos yaw, -sin yaw):
    three rings each standing proud of the last, never two in one plane."""
    with transformed((x, 0, z), yaw):
        cyl(0.62, 0.14, (x - 0.07, 0.95, z), 0xf2c14e, segs=12, axis='across')
        cyl(0.44, 0.06, (x + 0.07, 0.95, z), 0xfdf4de, segs=12, axis='across')
        cyl(0.27, 0.06, (x + 0.13, 0.95, z), 0x5a8fd8, segs=12, axis='across')
        cyl(0.11, 0.06, (x + 0.19, 0.95, z), 0xe66a5a, segs=8, axis='across')
        for sz in (-1, 1):
            bar((x + 0.15, 0.0, z + sz * 0.5), (x - 0.1, 1.2, z + sz * 0.2), 0.1, 0.1, 0x9a7b55)
        bar((x - 0.9, 0.0, z), (x - 0.15, 1.2, z), 0.1, 0.1, 0x9a7b55)

def gonfalon(x, z, color, h=3.2, yaw=0.0, wave=None):
    """A tourney banner: a pole on a toy block foot, a cross bar at its top
    and the cloth hung from it, its face to (cos yaw, -sin yaw), a yellow
    device on it. `wave` names the cloth's sway, hinged at the cross bar."""
    box((0.5, 0.5, 0.5), (x, 0.25, z), 0xd8a878)
    box((BAR, h, BAR), (x, h / 2 + 0.4, z), 0x2a2735)
    with transformed((x, 0, z), yaw):
        box((0.12, 0.12, 1.1), (x, h + 0.3, z), 0x2a2735)
        with animated(wave, (x, h + 0.3, z)) if wave else contextlib.nullcontext():
            box((0.08, 1.5, 0.9), (x, h - 0.5, z), color)
            box((0.06, 0.4, 0.4), (x + 0.06, h - 0.35, z), 0xf2c14e)
            box((0.08, 0.3, 0.3), (x, h - 1.38, z - 0.3), color)
            box((0.08, 0.3, 0.3), (x, h - 1.38, z + 0.3), color)

def toy_horse(x, z, coat, cloth, yaw=0.0, rider=None, lance=True):
    """A toy horse from the knights' set, about a racer and a half long, in
    its caparison of the side's colour, its head to (cos yaw, -sin yaw); a
    knight in the saddle, his lance couched over the horse's head."""
    with transformed((x, 0, z), yaw):
        for dx in (-0.55, 0.5):
            for dz in (-0.2, 0.2):
                box((0.18, 0.7, 0.18), (x + dx, 0.35, z + dz), coat)
        box((1.6, 0.6, 0.6), (x, 0.95, z), coat)                                 # the barrel
        box((1.3, 0.62, 0.7), (x - 0.02, 0.78, z), cloth)                        # the caparison, to the knees
        box((1.34, 0.12, 0.74), (x - 0.02, 0.5, z), 0xfdf4de)                    # its hem
        box((0.36, 0.9, 0.4), (x + 0.82, 1.45, z), coat, roll=-0.5)              # the neck
        box((0.62, 0.34, 0.36), (x + 1.2, 1.78, z), coat, roll=0.35)             # the head
        box((0.1, 0.5, 0.12), (x + 0.72, 1.75, z), 0x2a2735, roll=-0.5)          # the mane
        box((0.14, 0.7, 0.16), (x - 0.86, 0.9, z), 0x2a2735, roll=0.3)           # the tail
    if rider is not None:
        c, s_ = math.cos(yaw), math.sin(yaw)
        knight((x - 0.1 * c, 0.75, z + 0.1 * s_), rider, yaw)
        if lance:
            with transformed((x, 0, z), yaw):
                bar((x - 0.9, 1.75, z - 0.42), (x + 2.6, 1.95, z - 0.42), 0.12, 0.12, 0xfdf4de)
                box((0.3, 0.3, 0.3), (x + 0.2, 1.8, z - 0.42), rider)            # the vamplate

@piece(1.0)
def tilt_yard():
    # Gauntlet: the tourney's lists, outside the grid straight (+X to the
    # road, +Z the way the racers drive): the tilt, a long cloth-hung barrier
    # down the yard's middle, and two knights of the toy set riding at each
    # other along it, the red besieger from the south end and the castle's
    # blue from the north, lances couched; behind it the king's stand, a
    # course of the castle's own alphabet blocks under a striped canopy, the
    # king between two of his knights; a pavilion and a rack of shields at
    # each end, the sides' banners on tall poles along the back and a rope
    # on posts toward the road. Nothing here gallops: toy horses stand, and
    # only the cloth moves.
    R0, B0, Y0, CR = BESIEGERS, DEFENDERS, 0xf2c14e, 0xfdf4de
    L = 9.0                                        # half the tilt's length
    for k in range(7):                             # the tilt: posts, a rail, cloth panels in the sides' colours by turns
        box((0.18, 1.0, 0.18), (0, 0.5, -L + k * L / 3), 0x9a7b55)
    box((0.14, 0.14, 2 * L + 0.3), (0, 1.0, 0), 0x9a7b55)
    for k in range(12):
        box((0.08, 0.62, 1.3), (0, 0.6, -L + 0.75 + k * 1.5), (R0, CR, B0, CR)[k % 4])
    toy_horse(0.75, -3.4, 0x9a7b55, R0, yaw=-math.pi / 2, rider=R0)           # riding +Z, the road's side of the tilt
    toy_horse(-0.75, 3.4, 0xfdf4de, B0, yaw=math.pi / 2, rider=B0)            # riding -Z, the stand's side
    # the king's stand
    SX = -3.9
    top = block_run((SX, -3.9), (SX, 3.9), 0.0, 1, faces=('+x', '+y'))
    for sz in (-1, 1):
        for dx in (-0.55, 0.55):
            box((BAR, 2.5, BAR), (SX + dx, top + 1.25, sz * 3.7), 0x2a2735)
    for k in range(6):                                                         # the canopy, striped
        box((1.7, 0.14, 1.3), (SX, top + 2.55, -3.25 + k * 1.3), (Y0, B0)[k % 2], roll=0.12)
    knight((SX + 0.1, top, 0.0), Y0, 0.0)                                      # the king, in gold
    box((0.36, 0.14, 0.36), (SX + 0.1, top + 1.72, 0.0), Y0)                   # his crown over the plume
    for z in (-1.6, 1.6):
        knight((SX + 0.1, top, z), B0, 0.0)
    for z in (-2.9, 2.9):
        shield(SX + 0.72, top * 0.5, z, B0 if z > 0 else Y0)
    # the ends: a pavilion and its shields
    pavilion(-2.6, -L - 2.6, 1.3, 1.5, R0, R0)
    pavilion(-2.6, L + 2.6, 1.3, 1.5, B0, B0, flag=0x5a8fd8)
    shield_rack(0.6, -L - 2.4, (R0, Y0, R0))
    shield_rack(0.6, L + 2.4, (B0, CR, B0))
    for k, (z, c) in enumerate(((-L - 0.6, R0), (-L / 2, R0), (L / 2, B0), (L + 0.6, B0))):
        gonfalon(-5.6 if abs(z) < L else -4.6, z, c, h=3.6, wave='anim_sway:a=z:d=14:p=%.1f#gon%d' % (2.6 + 0.3 * k, k))
    for k in range(9):                                                         # the rope on its posts, toward the road
        box((0.16, 0.6, 0.16), (2.4, 0.3, -L - 1.0 + k * (2 * L + 2.0) / 8), CR)
    box((0.08, 0.08, 2 * L + 2.0), (2.4, 0.52, 0), 0xe66a5a)
    merge_paint()

@piece(1.0)
def tourney_camp():
    # Gauntlet: the tourney's camp in the east infield, inside the home
    # straight (+X to the road): the castle's knights' pavilions in a row,
    # blue and gold where the besiegers' across the lap are red, a rack of
    # shields before each; the archery range at its west end, three butts in
    # a row and two archers' stands; a quintain turning slowly on its post at
    # the east end, its shield one way and its sandbag the other; lances
    # stacked in a cone, a horse tethered by them, and the camp's banners.
    B0, Y0, G0, CR = DEFENDERS, 0xf2c14e, 0x6cbf6c, 0xfdf4de
    for k, (z, r, h, wall, roof) in enumerate(((-7.6, 1.3, 1.5, B0, B0), (-3.4, 1.2, 1.4, Y0, B0), (1.0, 1.7, 1.8, B0, Y0),
                                               (5.6, 1.2, 1.4, G0, B0), (9.6, 1.3, 1.5, B0, B0))):
        pavilion(-2.4 - 0.5 * (k % 2), z, r, h, wall, roof, flag=0x5a8fd8)
    for z, cols in ((-5.4, (B0, CR)), (3.3, (Y0, B0, Y0)), (7.7, (B0, G0))):
        shield_rack(0.3, z, cols)
    for k, z in enumerate((-15.4, -13.6, -11.8)):                              # the butts
        archery_butt(-1.2, z, 0.0)
    for z in (-14.5, -12.7):
        knight((1.9, 0.0, z), B0, math.pi)                                     # archers, facing the butts
    QX, QZ = 0.6, 13.6                                                         # the quintain
    box((0.6, 0.3, 0.6), (QX, 0.15, QZ), 0xd8a878)
    box((BAR * 1.3, 2.3, BAR * 1.3), (QX, 1.3, QZ), 0x9a7b55)
    with animated('anim_spin:a=y:w=0.5#quintain', (QX, 2.3, QZ)):
        box((0.14, 0.14, 2.6), (QX, 2.3, QZ), 0x9a7b55)
        shield(QX, 2.2, QZ - 1.3, 0xe66a5a, yaw=-math.pi / 2)
        box((0.06, 0.5, 0.06), (QX, 1.95, QZ + 1.25), 0x2a2735)
        box((0.4, 0.5, 0.4), (QX, 1.5, QZ + 1.25), 0xc8955a)                   # the sandbag
    for k in range(5):                                                         # lances stacked in a cone
        a = k * 2 * math.pi / 5
        bar((-0.2 + 0.7 * math.cos(a), 0.0, -9.8 + 0.7 * math.sin(a)), (-0.2, 2.6, -9.8), 0.1, 0.1, (CR, 0xe66a5a)[k % 2])
    toy_horse(1.0, 11.0, 0xfdf4de, B0, yaw=0.5, rider=None)
    box((BAR, 0.9, BAR), (2.2, 0.45, 10.2), 0x9a7b55)                           # its tethering post
    for k, (z, c) in enumerate(((-10.4, B0), (-0.9, Y0), (11.9, B0))):
        gonfalon(-4.8, z, c, h=3.4, wave='anim_sway:a=z:d=14:p=%.1f#camp%d' % (2.5 + 0.35 * k, k))
    merge_paint()

# What lies about Gauntlet's floor (theme.cc playroomTrack: the scatter's
# props, each under the lite tier's prop cap, square-edged).
@piece(1.0)
def tourney_shields():
    with plain_parts():
        shield_rack(0.0, 0.0, (BESIEGERS, 0xf2c14e, DEFENDERS), yaw=-math.pi / 2)   # a prop's face is +Z

@piece(1.0)
def tourney_butt():
    with plain_parts():
        archery_butt(0.0, 0.0, yaw=-math.pi / 2)

@piece(1.0)
def tourney_banner():
    with plain_parts():
        gonfalon(0.0, 0.0, DEFENDERS, h=2.8, yaw=-math.pi / 2)

# ---- build + export ----------------------------------------------------------------

def chamfer():
    """The cars' chamfer: every edge of a block or a bar cut at 45 degrees, one
    segment, a fifth of its thinnest side and never past CHAMFER. Hardened
    normals keep the faces flat and run the cut smooth between them, so a
    corner keeps one normal and the chamfer adds triangles, not vertices (a
    flat-shaded cut would cost a box four times its vertices). Not cylinders:
    there it triples the count and barely shows. A block marked 'round' gets
    a round-over instead: three segments, that wide (a third of its thinnest
    side at most)."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    for o in bpy.context.scene.objects:
        if o.type != 'MESH' or not o.get('chamfer'):
            continue
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        b = o.modifiers.new('chamfer', 'BEVEL')
        r = o.get('round')
        b.width = min(r, 0.33 * min(o.dimensions)) if r else min(CHAMFER, 0.2 * min(o.dimensions))
        b.segments = 3 if r else 1
        b.limit_method = 'ANGLE'
        b.angle_limit = math.radians(40)
        b.use_clamp_overlap = True
        b.harden_normals = True
        for p in o.data.polygons:
            p.use_smooth = True

CHAMFER = 0.05   # the car's 0.02 at its 0.9 length, at this scale and a little over

def join_groups():
    """Each group() becomes one object named after it, its parts' bevels
    applied first (a join keeps only the active object's modifiers)."""
    groups = {}
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and o.get('group'):
            groups.setdefault(o['group'], []).append(o)
    for name, objs in groups.items():
        for o in objs:
            bpy.ops.object.select_all(action='DESELECT')
            o.select_set(True)
            bpy.context.view_layer.objects.active = o
            for m in list(o.modifiers):
                bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        objs[0].name = name
        objs[0].data.name = name

def finalize_and_export(name):
    k = GROW.get(name, 1.0)
    shade()
    chamfer()
    join_groups()
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and not o.data.uv_layers:
            o.data.uv_layers.new(name='UVMap')
        if o.parent is None and k != 1.0:
            o.location = o.location * k
            o.scale = o.scale * k
    join_anims(k)
    bpy.ops.object.select_all(action='SELECT')
    out = os.path.join(OUT_DIR, 'set-%s.glb' % name)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_apply=True,
                              export_image_format='NONE', export_materials='EXPORT',
                              export_animations=False, export_skins=False, export_morph=False,
                              export_cameras=False, export_lights=False, export_extras=False,
                              export_vertex_color='NONE')
    tris = sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type == 'MESH')
    print('PIECE %s %s faces=%d grow=%.2f' % (name, out, tris, k))

os.makedirs(OUT_DIR, exist_ok=True)
for name, fn in PIECES.items():
    if ONLY and name not in ONLY:
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    fn()
    finalize_and_export(name)
