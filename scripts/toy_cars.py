# toy_cars.py — the game's cars, built in the Toy Car Kit's own construction,
# each a type whose design leaves the FRONT WHEELS in the open, because the
# player reads steering off them from the chase camera.
#
# The kit's grammar, measured off its vehicles: a 1/16 grid, chunky
# axis-aligned blocks with one 0.02 chamfer, flat shading, a whole face
# coloured at a time from the shared colormap (paint = an odd column of row 2,
# light at the top of the car; trim = row 3), the kit's own wheel, windows and
# glass painted onto faces. No thin rods: a strut or a pipe is a square bar
# about 0.04 across.
#
# The visibility rule, from the game's chase rig (ttp/camera.h: 1.15 behind,
# 0.69 up, aimed 1.7 ahead): the sightline to a front wheel passes about 0.3
# above the car's middle, so between the axles nothing wider than the wheels'
# inner face (|x| > 0.15) stands above 0.27, nothing covers a front wheel, and
# the body around the front axle stays inside the wheels. Tall is for the
# spine. Nose +Y, up Z, game units, under 0.45 high.
#
# One recipe (the user's pick, 2026-10-17): a solid tub between the wheels
# (half width about 0.16, so the wheels at 0.21 stand out of it), big wheels,
# and few bold details — windows, lamps, bumpers, a wing, a spare — which are
# what make a toy car read as one from behind.
#
# Imported by gen-concept-cars.py (headless export). For live work in Blender
# via the MCP: exec this file with REPO set, then build_all() lays every car
# out along X in its own collection.

import bmesh
import bpy
import math
import os
from mathutils import Matrix, Vector

REPO = globals().get('REPO') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
KIT = os.path.join(REPO, 'public', 'assets', 'toycar')

BEV = 0.02
CAR_H = (0.0, 0.45)  # the height the paint gradient runs over, light on top

# toy atlas cells (row, col)
PAINT = {'cream': (2, 1), 'green': (2, 3), 'gold': (2, 5), 'orange': (2, 7),
         'red': (2, 9), 'blue': (2, 11), 'sky': (2, 13), 'purple': (2, 15)}
SLATE = (3, 3)       # tyres, bumpers, struts
WINDOW = (3, 5)      # the kit's dark window
LIGHTSLATE = (3, 7)  # chrome
WHITE = (3, 9)       # hubs, lamps
GLASS = (2, 13)      # pale glass, pinned near its top (up-facing glass washes white)
DIRS = {'y+': (0, 1, 0), 'y-': (0, -1, 0), 'x+': (1, 0, 0), 'x-': (-1, 0, 0)}

_mat = None
_wheel_src = {}


def material():
    global _mat
    try:
        _mat.name  # a stale pointer after read_factory_settings raises
    except (AttributeError, ReferenceError):
        _mat = next((m for m in bpy.data.materials if m.name.startswith('colormap')), None)
    if _mat is None:
        _mat = bpy.data.materials.new('colormap')
        _mat.use_nodes = True
        tex = _mat.node_tree.nodes.new('ShaderNodeTexImage')
        tex.image = bpy.data.images.load(os.path.join(KIT, 'Textures', 'colormap.png'))
        tex.interpolation = 'Closest'
        bsdf = next(n for n in _mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        _mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 1.0
    return _mat


def uv_of(cell, pin):
    row, col = cell
    return ((col + 0.5) / 16, 1 - (row * 0.25 + 0.03 + 0.19 * max(0.0, min(1.0, pin))))


def pin_z(z):
    return 1 - (z - CAR_H[0]) / (CAR_H[1] - CAR_H[0])


class Car:
    """Collects parts; `finish` joins them, chamfers applied, into one body."""

    def __init__(self, name, paint):
        self.name = name
        self.paint = PAINT[paint] if isinstance(paint, str) else paint
        self.parts = []
        self.wheels = []   # (node name, mesh, location)
        self.col = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(self.col)

    # ---- geometry
    def _obj(self, name, bm, cell, bev):
        me = bpy.data.meshes.new(name)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        me.materials.append(material())
        o = bpy.data.objects.new(name, me)
        self.col.objects.link(o)
        if bev > 0:
            b = o.modifiers.new('bevel', 'BEVEL')
            b.width, b.segments, b.limit_method, b.angle_limit = bev, 1, 'ANGLE', math.radians(40)
            b.use_clamp_overlap = True
        me.uv_layers.new()
        for p in me.polygons:
            p.use_smooth = False
        self._set_uv(o, self.paint if cell == 'paint' else cell)
        self.parts.append(o)
        return o

    def _set_uv(self, o, cell, polys=None, pin=None):
        me = o.data
        uv = me.uv_layers.active.data
        for p in me.polygons:
            if polys is not None and p.index not in polys:
                continue
            for li in p.loop_indices:
                z = me.vertices[me.loops[li].vertex_index].co.z
                uv[li].uv = uv_of(cell, pin_z(z) if pin is None else pin)

    def box(self, name, lo, hi, cell='paint', bev=BEV, tilt=0.0):
        """An axis-aligned block, or with `tilt` one pitched about its own
        centre (degrees about X; negative lifts the tail end)."""
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        lo, hi = Vector(lo), Vector(hi)
        bmesh.ops.scale(bm, vec=hi - lo, verts=bm.verts)
        if tilt:
            bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.radians(tilt), 3, 'X'), verts=bm.verts)
        bmesh.ops.translate(bm, vec=(lo + hi) / 2, verts=bm.verts)
        return self._obj(name, bm, cell, bev)

    def strut(self, name, a, b, t=0.04, cell=SLATE):
        """A square bar of side t running from point a to point b: a raked
        wing support, where a vertical bar would read as a fence post."""
        a, b = Vector(a), Vector(b)
        d = b - a
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=(t, d.length, t), verts=bm.verts)
        rot = Vector((0, 1, 0)).rotation_difference(d.normalized()).to_matrix()
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=rot, verts=bm.verts)
        bmesh.ops.translate(bm, vec=(a + b) / 2, verts=bm.verts)
        return self._obj(name, bm, cell, 0.008)

    def loft(self, name, secs, cell='paint', bev=BEV):
        """Rectangular sections (y, half width, z0, z1) lofted along Y."""
        bm = bmesh.new()
        rings = []
        for y, hw, z0, z1 in secs:
            rings.append([bm.verts.new((x, y, z)) for x, z in ((-hw, z0), (hw, z0), (hw, z1), (-hw, z1))])
        for r0, r1 in zip(rings, rings[1:]):
            for a in range(4):
                b = (a + 1) % 4
                bm.faces.new((r0[a], r0[b], r1[b], r1[a]))
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])
        return self._obj(name, bm, cell, bev)

    def bar(self, name, lo, hi, cell=SLATE):
        return self.box(name, lo, hi, cell, 0.008)

    def plate(self, name, lo, hi, cell='paint'):
        return self.box(name, lo, hi, cell, 0.01)

    def pair(self, fn, name, x0, x1, lo, hi, *args, **kw):
        """Left and right copies of a box-like part spanning |x| in x0..x1."""
        out = []
        for s in (-1, 1):
            l, h = list(lo), list(hi)
            l[0], h[0] = sorted((s * x0, s * x1))
            out.append(fn(f'{name}{"L" if s < 0 else "R"}', l, h, *args, **kw))
        return out

    def paint_faces(self, o, dirn, cell, pin=None, **bounds):
        """Recolour the faces of o facing dirn whose centre lies in bounds (x=, y=, z= ranges)."""
        d = Vector(dirn).normalized()
        me = o.data
        sel = set()
        for p in me.polygons:
            if p.normal.dot(d) < 0.5:
                continue
            c = p.center
            if all(bounds[k][0] <= c[i] <= bounds[k][1] for k, i in (('x', 0), ('y', 1), ('z', 2)) if k in bounds):
                sel.add(p.index)
        self._set_uv(o, cell, sel, pin)
        return o

    # ---- the details, bold and few
    def lamps(self, y, z, x0=0.07, x1=0.12, size=0.05):
        """A front pair of white lamp blocks standing proud of the nose face at y."""
        return self.pair(self.box, 'lamp', x0, x1, (0, y - 0.01, z), (0, y + 0.03, z + size), WHITE, 0.008)

    def tails(self, y, z, x0=0.08, x1=0.14, cell=None):
        """A rear pair of tail lamps on the tail face at y (red, or `cell` on a red car)."""
        return self.pair(self.box, 'tail', x0, x1, (0, y - 0.025, z), (0, y + 0.01, z + 0.04),
                         cell or PAINT['red'], 0.006)

    def bumper(self, y, z, front=True, hw=0.18, h=0.04, d=0.04, cell=SLATE):
        """A bumper slab across the nose (front) or the tail at y, slate unless chrome."""
        lo = (-hw, y if front else y - d, z)
        hi = (hw, (y + d) if front else y, z + h)
        return self.box('bumper' + ('F' if front else 'R'), lo, hi, cell, 0.01)

    def windows(self, o, dirs=('y+', 'y-', 'x+', 'x-'), **bounds):
        """The kit's dark windows painted onto the faces of o facing dirs."""
        for d in dirs:
            self.paint_faces(o, DIRS[d], WINDOW, **bounds)
        return o

    def grille(self, y, z0, z1, hw=0.08):
        """A slate grille block standing a little proud of the nose face at y."""
        return self.box('grille', (-hw, y - 0.01, z0), (hw, y + 0.015, z1), SLATE, 0.006)

    def wing(self, y0, y1, z, hw=0.17, struts=(0.08, 0.12), base=0.27):
        """A rear wing plate on two struts rising from `base`."""
        self.pair(self.bar, 'strut', *struts, (0, y0 + 0.02, base), (0, y0 + 0.08, z))
        return self.plate('wing', (-hw, y0, z), (hw, y1, z + 0.03))

    def exhausts(self, y, z, x0=0.05, x1=0.1):
        """A pair of slate exhaust blocks under the tail."""
        return self.pair(self.bar, 'exhaust', x0, x1, (0, y - 0.03, z), (0, y + 0.01, z + 0.04))

    def splitter(self, y, z, hw=0.18):
        """A slate splitter lip low across the nose."""
        return self.plate('splitter', (-hw, y - 0.04, z), (hw, y + 0.02, z + 0.03), SLATE)

    # ---- wheels
    def wheel(self, front, y, x, r, w):
        for s, side in ((-1, 'l'), (1, 'r')):
            self.wheels.append((f"wheel-{'f' if front else 'b'}{side}", wheel_mesh(s < 0, r, w), (s * x, y, r)))

    def spare(self, name, loc, r, w):
        """A spare wheel joined into the body, hub along Y."""
        me = wheel_mesh(False, r, w)
        me.transform(Matrix.Translation(loc) @ Matrix.Rotation(math.radians(90), 4, 'Z'))
        o = bpy.data.objects.new(name, me)
        self.col.objects.link(o)
        self.parts.append(o)
        return o

    # ---- finish
    def finish(self, x_offset=0.0, live=False):
        """Join the parts into one body object at x_offset. `live` also makes
        the wheel objects, parented, for looking at in Blender."""
        dg = bpy.context.evaluated_depsgraph_get()
        bm = bmesh.new()
        for o in self.parts:
            me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
            me.transform(o.matrix_world)
            bm.from_mesh(me)
            bpy.data.meshes.remove(me)
            bpy.data.objects.remove(o)
        me = bpy.data.meshes.new(self.name)
        bm.to_mesh(me)
        bm.free()
        for p in me.polygons:
            p.use_smooth = False
        me.materials.append(material())
        body = bpy.data.objects.new(self.name, me)
        self.col.objects.link(body)
        body.location.x = x_offset
        if live:
            for wname, wme, loc in self.wheels:
                o = bpy.data.objects.new(wname, wme)
                self.col.objects.link(o)
                o.parent = body
                o.location = loc
        hi = max(v.co.z for v in me.vertices)
        wid = max(abs(loc[0]) + max(abs(v.co.x) for v in wme.vertices) for _, wme, loc in self.wheels)
        assert hi <= CAR_H[1] + 1e-6, f'{self.name} is {hi:.3f} high'
        print(f'{self.name}: height {hi:.3f}, width over wheels {2 * wid:.3f}')
        return body


# The kit's standard wheel (slate tyre, white hub) rides on every shipped car,
# so the shipped GT is where it is read back from: the kit vehicle it came off
# (the speedster) is no longer in the folder.
WHEEL_SOURCE = 'vehicle-gt.glb'


def wheel_mesh(left, r, w):
    """The kit's standard wheel at radius r and width w, hub facing out."""
    key = 'l' if left else 'r'
    try:
        _wheel_src[key].name
    except (KeyError, ReferenceError):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(KIT, WHEEL_SOURCE))
        new = [o for o in bpy.data.objects if o not in before]
        for o in new:
            n = o.name.split('.')[0]
            if n in ('wheel-fl', 'wheel-fr'):
                me = o.data.copy()
                me.name = 'kit-wheel-' + n[-1]
                me.materials.clear()
                me.materials.append(material())
                _wheel_src[n[-1]] = me
        for o in new:
            bpy.data.objects.remove(o)
    me = _wheel_src[key].copy()
    vs = [v.co for v in me.vertices]
    lo = Vector([min(v[i] for v in vs) for i in range(3)])
    hi = Vector([max(v[i] for v in vs) for i in range(3)])
    me.transform(Matrix.Diagonal((w / (hi.x - lo.x), 2 * r / (hi.y - lo.y), 2 * r / (hi.z - lo.z), 1))
                 @ Matrix.Translation(-(lo + hi) / 2))
    return me


# ============================================================== the cars

def gt(c):
    """GT coupe: long hood with a scoop (the only one on the grid), a fastback glasshouse with a rear window over a short deck, rear wing, twin exhausts, splitter."""
    c.wheel(True, 0.27, 0.21, 0.13, 0.14)
    c.wheel(False, -0.25, 0.21, 0.13, 0.14)
    c.box('body', (-0.16, -0.4, 0.13), (0.16, 0.14, 0.27))
    c.loft('hood', [(0.42, 0.15, 0.13, 0.23), (0.14, 0.16, 0.13, 0.27)])
    # The rear window is pitched steeper than the deck behind it: windows()
    # paints a face only within 60 degrees of its direction, and the old
    # one-piece fastback slope missed that, so the GT had no back window.
    c.windows(c.loft('glass', [(0.14, 0.14, 0.27, 0.29), (0.02, 0.14, 0.27, 0.4),
                               (-0.12, 0.14, 0.27, 0.4), (-0.24, 0.14, 0.27, 0.32)]))
    c.loft('deck', [(-0.24, 0.14, 0.27, 0.32), (-0.34, 0.14, 0.27, 0.3)])
    c.box('scoop', (-0.05, 0.2, 0.26), (0.05, 0.34, 0.31), SLATE)
    c.wing(-0.42, -0.34, 0.36)
    c.exhausts(-0.4, 0.14)
    c.splitter(0.42, 0.1)
    c.grille(0.42, 0.15, 0.21, 0.08)
    c.lamps(0.41, 0.17, 0.09, 0.14, 0.04)
    c.bumper(-0.4, 0.13, front=False, hw=0.17, h=0.03)
    c.tails(-0.4, 0.2)


def jeep(c):
    """Open 4x4: tall tub, flat hood and upright screen, a roll hoop and a spare on the tail."""
    c.wheel(True, 0.27, 0.21, 0.14, 0.15)
    c.wheel(False, -0.25, 0.21, 0.14, 0.15)
    c.box('tub', (-0.16, -0.4, 0.14), (0.16, 0.12, 0.32))
    c.paint_faces(c.box('hood', (-0.14, 0.12, 0.14), (0.14, 0.42, 0.3)), (0, 1, 0), SLATE)
    c.plate('screen', (-0.14, 0.1, 0.32), (0.14, 0.12, 0.42), GLASS)
    c.pair(c.box, 'seat', 0.03, 0.13, (0, -0.1, 0.32), (0, 0.02, 0.4), SLATE)
    c.pair(c.bar, 'hoop', 0.12, 0.16, (0, -0.2, 0.32), (0, -0.16, 0.44))
    c.bar('hoopTop', (-0.16, -0.2, 0.4), (0.16, -0.16, 0.44))
    c.spare('spare', (0, -0.44, 0.28), 0.1, 0.06)
    c.bumper(0.42, 0.12)
    c.bumper(-0.4, 0.12, front=False, d=0.06)
    c.pair(c.box, 'lamp', 0.07, 0.12, (0, 0.4, 0.22), (0, 0.44, 0.27), WHITE, 0.01)


def lemans(c):
    """Group C prototype: wide and flat, a dark canopy with a snorkel behind it, a pitched full-width wing on two raked struts, quad lamps, a roundel on the nose."""
    c.wheel(True, 0.27, 0.21, 0.125, 0.13)
    c.wheel(False, -0.25, 0.21, 0.125, 0.13)
    c.loft('body', [(0.4375, 0.12, 0.1, 0.15), (0.3, 0.16, 0.1, 0.22), (-0.42, 0.16, 0.1, 0.25)])
    can = c.loft('canopy', [(0.16, 0.1, 0.24, 0.26), (0.06, 0.1, 0.24, 0.35), (-0.08, 0.1, 0.24, 0.35),
                            (-0.16, 0.1, 0.24, 0.28)])
    c.windows(can, ('y+', 'x+', 'x-'))
    c.box('snorkel', (-0.04, -0.3, 0.25), (0.04, -0.12, 0.33), SLATE)
    # The wing pitched nose-down like a real one, on struts raked back from
    # the deck ahead of it — they meet the wing at an angle, not as posts.
    c.box('wing', (-0.19, -0.44, 0.355), (0.19, -0.36, 0.385), bev=0.01, tilt=-12)
    for sx in (-0.12, 0.12):
        c.strut(f'strut{sx:+.2f}', (sx, -0.28, 0.23), (sx, -0.41, 0.365))
    c.plate('roundel', (-0.05, 0.16, 0.22), (0.05, 0.26, 0.235), WHITE)
    c.splitter(0.4375, 0.08)
    c.lamps(0.4, 0.14, 0.04, 0.07, 0.03)
    c.lamps(0.4, 0.14, 0.08, 0.11, 0.03)
    c.exhausts(-0.42, 0.12, 0.06, 0.11)
    c.tails(-0.42, 0.19, 0.09, 0.14, cell=PAINT['orange'])


def jeep_hardtop(c):
    """Hardtop 4x4: a roofed cab with windows all round, roof rails with lamps, a bull bar, the spare on the tail."""
    c.wheel(True, 0.27, 0.21, 0.14, 0.15)
    c.wheel(False, -0.25, 0.21, 0.14, 0.15)
    c.box('tub', (-0.16, -0.4, 0.14), (0.16, 0.12, 0.3))
    c.paint_faces(c.box('hood', (-0.14, 0.12, 0.14), (0.14, 0.42, 0.3)), (0, 1, 0), SLATE)
    c.windows(c.box('cab', (-0.14, -0.38, 0.3), (0.14, 0.12, 0.42)))
    c.pair(c.bar, 'rail', 0.1, 0.14, (0, -0.36, 0.42), (0, 0.0, 0.45))
    c.pair(c.box, 'rooflamp', 0.04, 0.08, (0, 0.08, 0.42), (0, 0.12, 0.45), WHITE, 0.006)
    c.spare('spare', (0, -0.44, 0.26), 0.1, 0.06)
    c.bar('bull', (-0.16, 0.44, 0.17), (0.16, 0.48, 0.21))
    c.pair(c.bar, 'bullpost', 0.08, 0.12, (0, 0.44, 0.12), (0, 0.48, 0.28))
    c.bumper(0.42, 0.12)
    c.bumper(-0.4, 0.12, front=False, d=0.06)
    c.pair(c.box, 'lamp', 0.07, 0.12, (0, 0.4, 0.22), (0, 0.44, 0.27), WHITE, 0.01)
    c.tails(-0.4, 0.19, 0.11, 0.15)


def pony(c):
    """Pony fastback: a long hood under twin white stripes, a fastback roof with rear louvres, quad lamps, chrome bumpers."""
    c.wheel(True, 0.26, 0.21, 0.13, 0.14)
    c.wheel(False, -0.26, 0.21, 0.13, 0.16)
    c.box('body', (-0.16, -0.42, 0.13), (0.16, 0.42, 0.27))
    cab = c.loft('cabin', [(0.12, 0.14, 0.27, 0.29), (0.02, 0.14, 0.27, 0.4), (-0.12, 0.14, 0.27, 0.4),
                           (-0.34, 0.14, 0.27, 0.3)])
    c.windows(cab, ('y+', 'x+', 'x-'), y=(-0.14, 0.14))
    louvres(c, -0.12, 0.4, -0.34, 0.3)
    c.pair(c.plate, 'stripe', 0.02, 0.06, (0, 0.14, 0.27), (0, 0.4, 0.278), WHITE)
    c.pair(c.plate, 'roofstripe', 0.02, 0.06, (0, -0.12, 0.4), (0, 0.02, 0.408), WHITE)
    c.plate('spoiler', (-0.16, -0.44, 0.27), (0.16, -0.4, 0.31))
    c.grille(0.42, 0.17, 0.25, 0.03)
    c.bumper(0.42, 0.12, hw=0.17, cell=LIGHTSLATE)
    c.bumper(-0.4, 0.12, front=False, hw=0.17, cell=LIGHTSLATE)
    c.lamps(0.42, 0.18, 0.04, 0.08, 0.04)
    c.lamps(0.42, 0.18, 0.1, 0.14, 0.04)
    c.exhausts(-0.42, 0.13, 0.05, 0.1)
    c.tails(-0.42, 0.2)


def muscle_trim(c, hood, roof, nose_y, nose_z, tail_y, z0=0.12):
    """The pony's dress on another body: twin white stripes over the hood
    (a (y0, y1, z, tilt) slope) and the roof (y0, y1, z), quad lamps on the
    nose face at nose_y / nose_z, chrome bumpers at nose_y and tail_y."""
    y0, y1, z, tilt = hood
    c.pair(c.box, 'stripe', 0.02, 0.06, (0, y0, z), (0, y1, z + 0.008), WHITE, 0.01, tilt=tilt)
    y0, y1, z = roof
    c.pair(c.plate, 'roofstripe', 0.02, 0.06, (0, y0, z), (0, y1, z + 0.008), WHITE)
    c.lamps(nose_y, nose_z, 0.04, 0.08, 0.04)
    c.lamps(nose_y, nose_z, 0.1, 0.14, 0.04)
    c.bumper(nose_y, z0, hw=0.17, cell=LIGHTSLATE)
    c.bumper(tail_y, z0, front=False, hw=0.17, cell=LIGHTSLATE)


def louvres(c, y0, z0, y1, z1, n=3, hw=0.1):
    """Slate louvres laid down a rear slope from (y0, z0) to (y1, z1)."""
    for i in range(1, n + 1):
        t = i / (n + 1)
        y, z = y0 + (y1 - y0) * t, z0 + (z1 - z0) * t
        c.plate(f'louvre{i}', (-hw, y - 0.012, z), (hw, y + 0.012, z + 0.025), SLATE)


def stock(c):
    """Fastback stocker in muscle dress: twin white stripes the length of the hood and over the roof, louvres down the sail, quad lamps, chrome bumpers, door numbers, side pipes, no scoop."""
    c.wheel(True, 0.26, 0.21, 0.13, 0.14)
    c.wheel(False, -0.26, 0.21, 0.13, 0.14)
    c.box('body', (-0.16, -0.42, 0.13), (0.16, 0.26, 0.28))
    c.loft('nose', [(0.4, 0.15, 0.13, 0.2), (0.26, 0.16, 0.13, 0.28)])
    c.windows(c.loft('cabin', [(0.08, 0.14, 0.28, 0.3), (-0.02, 0.14, 0.28, 0.4), (-0.2, 0.14, 0.28, 0.4)]))
    c.loft('sail', [(-0.2, 0.14, 0.28, 0.4), (-0.42, 0.14, 0.28, 0.3)])
    louvres(c, -0.2, 0.4, -0.42, 0.3)
    c.plate('spoiler', (-0.17, -0.44, 0.3), (0.17, -0.4, 0.35))
    c.pair(c.plate, 'number', 0.16, 0.17, (0, -0.14, 0.15), (0, 0.08, 0.27), WHITE)
    c.pair(c.bar, 'pipe', 0.16, 0.2, (0, -0.1, 0.14), (0, 0.1, 0.18))
    c.pair(c.plate, 'hoodstripe', 0.02, 0.06, (0, 0.08, 0.28), (0, 0.28, 0.288), WHITE)
    muscle_trim(c, hood=(0.27, 0.39, 0.237, -29.7), roof=(-0.19, -0.03, 0.4), nose_y=0.4, nose_z=0.15,
                tail_y=-0.42)
    c.tails(-0.42, 0.2)


def hatch_muscle(c):
    """Hot hatch in the pony's dress: stripes over bonnet and roof, quad lamps, chrome bumpers; the roof vent gives way to the stripes."""
    c.wheel(True, 0.26, 0.21, 0.13, 0.14)
    c.wheel(False, -0.26, 0.21, 0.13, 0.14)
    c.box('body', (-0.16, -0.42, 0.13), (0.16, 0.2, 0.28))
    c.loft('nose', [(0.42, 0.15, 0.13, 0.22), (0.2, 0.16, 0.13, 0.28)])
    c.windows(c.loft('cabin', [(0.2, 0.14, 0.28, 0.29), (0.08, 0.14, 0.28, 0.41), (-0.36, 0.14, 0.28, 0.41),
                               (-0.4, 0.14, 0.28, 0.36)]))
    c.plate('roofspoiler', (-0.15, -0.42, 0.4), (0.15, -0.34, 0.43))
    c.grille(0.42, 0.14, 0.2, 0.03)
    muscle_trim(c, hood=(0.22, 0.4, 0.25, -15.3), roof=(-0.33, 0.06, 0.41), nose_y=0.4, nose_z=0.16,
                tail_y=-0.42)
    c.tails(-0.42, 0.2, 0.1, 0.15)
    c.pair(c.bar, 'pipe', 0.05, 0.09, (0, -0.45, 0.12), (0, -0.41, 0.16))


# THE ROSTER: one car per role, its look matching its stats and its paint the
# role's established colour, so every table keyed on a role's body tone (the
# item chips, the TV shells' copies) still holds. The user's picks of
# 2026-10-17/18, out of three review rounds of alternates (git history has
# them). Each car owns its signature detail: only the GT has a scoop, only the
# prototype a strutted wing, only the stocker stripes, only the jeep a spare.
#   Dash   balanced              GT coupe                    green
#   Bolt   fastest, lightest     Group C prototype           red
#   Carve  corner king, heavier  fastback stocker, muscle dress  blue
#   Rumble heaviest, slow launch jeep                        purple
# Exported into public/assets/toycar/ by gen-concept-cars.py --roster.
ROSTER = {
    'vehicle-gt': (gt, 'green'),
    'vehicle-lemans': (lemans, 'red'),
    'vehicle-stock': (stock, 'blue'),
    'vehicle-jeep': (jeep, 'purple'),
}

# The concept cars still in the asset gallery, the basis for whatever comes
# next: name -> (builder, paint), in the gallery's order, a roster car's
# variations named tk-<car>-<cut> after it. The note is the builder's docstring.
CARS = {
    'tk-stock-hatch-muscle': (hatch_muscle, 'blue'),
    'tk-jeep-b': (jeep_hardtop, 'purple'),
    'tk-muscle-c': (pony, 'orange'),
}


def build(name, x=0.0, live=False):
    """(body, [(wheel node, mesh, location)]) for one car, roster or concept."""
    fn, paint = ROSTER[name] if name in ROSTER else CARS[name]
    c = Car(name, paint)
    fn(c)
    return c.finish(x, live), c.wheels


def build_all(names=None, spacing=1.2):
    """Live: rebuild every car (or `names`) side by side in Blender."""
    for col in [c for c in bpy.data.collections if c.name in ROSTER or c.name in CARS]:
        for o in list(col.objects):
            bpy.data.objects.remove(o)
        bpy.data.collections.remove(col)
    for i, name in enumerate(names or list(ROSTER) + list(CARS)):
        build(name, i * spacing, live=True)
