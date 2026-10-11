"""Blender 5.2 pipeline: dress the Quaternius base humans and export web GLBs.

Run headless:
  blender -b --python scripts/assets/build_characters.py -- <asset-cache> <output-dir>

The Universal Base Characters ship as rigged bodies without clothing. Each
cast member is built from one of them: the body is decimated for the web,
work clothing (jacket, trousers, boots and optional reflective bands) is
modelled from the body's own surface so it keeps the skin weights, skin hidden
under the clothing is removed so it cannot poke through, ambient occlusion is
baked into the clothing, hair is bone-parented to the head, and only the clips
each character uses are copied from the Universal Animation Library. The two
rigs share bone names and rest poses, so the clips transfer without retargeting.
"""
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

CACHE, OUTPUT = (Path(p) for p in sys.argv[sys.argv.index("--") + 1:][:2])
UBC = next((CACHE / "quaternius" / "ubc").glob("*/"))
BODY_DIR = UBC / "Base Characters" / "Godot - UE"
SKIN_DIR = UBC / "Base Characters" / "Textures"
HAIR_DIR = UBC / "Hairstyles" / "Origin at 0" / "glTF (Godot)"
ANIMATIONS = next((CACHE / "quaternius" / "ual").rglob("UAL1_Standard.glb"))

SKIN = {
    ("Male", "Dark"): "T_Superhero_Male_Dark.png", ("Male", "Light"): "T_Superhero_Male_Ligh.png",
    ("Female", "Dark"): "T_Superhero_Female_Dark_BaseColor.png", ("Female", "Light"): "T_Superhero_Female_Light_BaseColor.png",
}
CAST = {
    # Mara Venn, the player: borough recovery waterproof with amber bands.
    "mara": dict(body="Female", skin="Dark", hair=["Hair_BuzzedFemale"], hair_color=(0.03, 0.025, 0.02),
                 jacket=(0.035, 0.12, 0.14), trousers=(0.07, 0.075, 0.08), boots=(0.02, 0.02, 0.02), bands=(0.95, 0.6, 0.16),
                 clips=["Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Jump_Start", "Jump_Loop", "Jump_Land", "Interact"]),
    # First-person view: the same sleeves and hands, nothing else.
    "mara_arms": dict(body="Female", skin="Dark", hair=[], hair_color=(0, 0, 0), arms=True,
                      jacket=(0.035, 0.12, 0.14), trousers=(0.07, 0.075, 0.08), boots=(0.02, 0.02, 0.02), bands=(0.95, 0.6, 0.16),
                      clips=["Idle_Torch_Loop", "Interact"]),
    # Ivo keeps the clinic feeder alive: dark clinic waterproof with white bands.
    "ivo": dict(body="Male", skin="Dark", hair=["Hair_Buzzed", "Hair_Beard"], hair_color=(0.035, 0.03, 0.028),
                jacket=(0.05, 0.13, 0.16), trousers=(0.09, 0.10, 0.11), boots=(0.025, 0.025, 0.025), bands=(0.85, 0.88, 0.86),
                clips=["Fixing_Kneeling", "Idle_Talking_Loop", "Idle_Loop"]),
    # Dax prints the Quay Ledger: an olive parka, jeans and a torch.
    "dax": dict(body="Male", skin="Light", hair=["Hair_SimpleParted"], hair_color=(0.12, 0.075, 0.045),
                jacket=(0.20, 0.21, 0.11), trousers=(0.07, 0.10, 0.17), boots=(0.055, 0.035, 0.022), bands=None,
                clips=["Idle_Torch_Loop", "Idle_Talking_Loop", "Idle_Loop"]),
    # Sera Holt runs the harbour desk: municipal hi-vis.
    "sera": dict(body="Female", skin="Light", hair=["Hair_Buns"], hair_color=(0.16, 0.10, 0.06),
                 jacket=(0.95, 0.33, 0.03), trousers=(0.04, 0.06, 0.10), boots=(0.02, 0.02, 0.02), bands=(0.9, 0.92, 0.9),
                 clips=["Idle_Loop", "Idle_Talking_Loop"]),
    "evacuee_a": dict(body="Female", skin="Dark", hair=["Hair_Long"], hair_color=(0.03, 0.025, 0.02),
                      jacket=(0.55, 0.06, 0.05), trousers=(0.12, 0.12, 0.13), boots=(0.03, 0.03, 0.03), bands=None,
                      clips=["Sitting_Idle_Loop", "Sitting_Talking_Loop"]),
    "evacuee_b": dict(body="Male", skin="Light", hair=["Hair_Buzzed"], hair_color=(0.30, 0.22, 0.13),
                      jacket=(0.86, 0.66, 0.07), trousers=(0.10, 0.11, 0.08), boots=(0.03, 0.04, 0.03), bands=None,
                      clips=["Sitting_Idle_Loop"]),
}
DECIMATE = 0.45
TEXTURE = {"Eye": 128, "Hair": 256, "BaseColor": 1024, "Normal": 512, "Roughness": 256}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_gltf(path, merge=False):
    before = set(bpy.data.objects)
    # Merging welds the body along its texture seams so decimation and cloth
    # smoothing cannot open cracks there; UVs stay split per face corner.
    bpy.ops.import_scene.gltf(filepath=str(path), merge_vertices=merge)
    # Some pack glTFs reference "<name>_png.png" where the file is "<name>.png".
    for image in bpy.data.images:
        source = Path(bpy.path.abspath(image.filepath)) if image.filepath else None
        if source and not source.exists() and source.name.endswith("_png.png"):
            image.filepath = str(source.with_name(source.name.replace("_png.png", ".png")))
            image.reload()
    return [o for o in bpy.data.objects if o not in before]


def load_clips(names):
    """Keep the requested actions from the animation library; drop its mannequin."""
    objects = import_gltf(ANIMATIONS)
    keep = {a.name: a for a in bpy.data.actions if a.name in names}
    missing = set(names) - set(keep)
    assert not missing, f"missing clips {missing}"
    for action in bpy.data.actions:
        if action.name not in keep:
            bpy.data.actions.remove(action)
    for action in keep.values():
        action.use_fake_user = True
    for obj in objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    return keep


def material(name, color, roughness=0.8, emission=0.0, occlusion=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    shader = nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    if emission:
        shader.inputs["Emission Color"].default_value = (*color, 1)
        shader.inputs["Emission Strength"].default_value = emission
    if occlusion:
        # Baked occlusion multiplies the cloth colour; exported as COLOR_0.
        attribute = nodes.new("ShaderNodeVertexColor")
        attribute.layer_name = "Occlusion"
        mix = nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs["A"].default_value = (*color, 1)
        mat.node_tree.links.new(attribute.outputs["Color"], mix.inputs["B"])
        mat.node_tree.links.new(mix.outputs["Result"], shader.inputs["Base Color"])
    return mat


def landmarks(armature):
    bones = {b.name: (armature.matrix_world @ b.head_local) for b in armature.data.bones}
    s = bones["Head"].z / 1.6
    pelvis = bones["pelvis"].z
    marks = dict(scale=s, hem=pelvis + 0.035 * s, boot=0.17 * bones["Head"].z, collar=bones["neck_01"].z + 0.035 * s,
                 wrist=abs(bones["hand_l"].x) - 0.035 * s, chest=0.79 * bones["Head"].z, calf=0.30 * bones["Head"].z,
                 elbow=(abs(bones["upperarm_l"].x) + abs(bones["lowerarm_l"].x)) / 2 + 0.06 * s, arm_z=bones["upperarm_l"].z)
    marks["band"] = 0.02 * s
    marks["head"] = bones["Head"].z - 0.01 * s
    marks["neck_y"] = bones["neck_01"].y
    return marks


def cut(bm, normal, offset, keep):
    """Bisect only the geometry selected by keep(position) along a plane."""
    geom = [f for f in bm.faces if keep(f.calc_center_median())]
    edges = {e for f in geom for e in f.edges}
    verts = {v for f in geom for v in f.verts}
    bmesh.ops.bisect_plane(bm, geom=list(verts) + list(edges) + geom, plane_co=Vector(normal) * offset, plane_no=Vector(normal))


def region_of(c, m):
    arm = c.z > m["arm_z"] - 0.12 * m["scale"] and abs(c.x) > 0.17 * m["scale"]
    if arm and abs(c.x) > m["wrist"]:
        return "skin"
    if not arm and (c.z > m["head"] or (c.z > m["collar"] and abs(c.x) < 0.085 * m["scale"] and abs(c.y - m["neck_y"]) < 0.09 * m["scale"])):
        return "skin"
    if c.z < m["boot"]:
        return "boots"
    return "jacket" if c.z > m["hem"] else "trousers"


def band_of(c, kind, m):
    arm = c.z > m["arm_z"] - 0.12 * m["scale"] and abs(c.x) > 0.17 * m["scale"]
    w = m["band"]
    if kind == "jacket" and arm:
        return abs(abs(c.x) - m["elbow"]) < w
    if kind == "jacket":
        return abs(c.z - m["chest"]) < w or m["hem"] < c.z < m["hem"] + 1.6 * w
    return kind == "trousers" and abs(c.z - m["calf"]) < w


def largest_loop(edges):
    """Keep the biggest connected run of edges (the hip loop)."""
    edges = set(edges)
    best = []
    while edges:
        group, stack = set(), [edges.pop()]
        while stack:
            e = stack.pop()
            group.add(e)
            for v in e.verts:
                for other in v.link_edges:
                    if other in edges:
                        edges.remove(other)
                        stack.append(other)
        if len(group) > len(best):
            best = list(group)
    return best


def dress(body, armature, spec):
    """Model clothing from a copy of the body surface; return the clothing object."""
    m = landmarks(armature)
    s = m["scale"]
    # Straight plane cuts give clean hems, cuffs, collar and band edges.
    bm = bmesh.new()
    bm.from_mesh(body.data)
    is_arm = lambda c: c.z > m["arm_z"] - 0.12 * s and abs(c.x) > 0.17 * s
    for z in (m["boot"], m["hem"]):
        cut(bm, (0, 0, 1), z, lambda c: not is_arm(c))
    cut(bm, (0, 0, 1), m["collar"], lambda c: abs(c.x) < 0.16 * s)
    for side in (1, -1):
        cut(bm, (side, 0, 0), m["wrist"], lambda c, side=side: is_arm(c) and c.x * side > 0)
    if spec["bands"]:
        w = m["band"]
        for z in (m["chest"] - w, m["chest"] + w, m["hem"] + 1.6 * w, m["calf"] - w, m["calf"] + w):
            cut(bm, (0, 0, 1), z, lambda c: not is_arm(c))
        for side in (1, -1):
            for x in (m["elbow"] - w, m["elbow"] + w):
                cut(bm, (side, 0, 0), x, lambda c, side=side: is_arm(c) and c.x * side > 0)
    bm.to_mesh(body.data)
    bm.free()

    clothing = body.copy()
    clothing.data = body.data.copy()
    clothing.name = body.name + "_Clothing"
    bpy.context.scene.collection.objects.link(clothing)
    clothing.data.materials.clear()
    slots = {}
    for key, color, rough in (("jacket", spec["jacket"], 0.55), ("trousers", spec["trousers"], 0.85), ("boots", spec["boots"], 0.45)):
        clothing.data.materials.append(material(f"Cloth_{key}", color, rough, occlusion=True))
        slots[key] = len(clothing.data.materials) - 1
    if spec["bands"]:
        clothing.data.materials.append(material("Cloth_reflective", spec["bands"], 0.3, emission=0.15, occlusion=True))
        slots["band"] = len(clothing.data.materials) - 1

    bm = bmesh.new()
    bm.from_mesh(clothing.data)
    # The body is split along its texture seams; plain-coloured cloth is welded
    # so smoothing cannot open cracks along them.
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0004)
    kinds = {}
    remove = []
    for face in bm.faces:
        centre = clothing.matrix_world @ face.calc_center_median()
        kind = region_of(centre, m)
        if kind == "skin":
            remove.append(face)
            continue
        kinds[face] = kind
        face.material_index = slots["band"] if spec["bands"] and band_of(centre, kind, m) else slots[kind]
    vertex_kind = {}
    for face, kind in kinds.items():
        for v in face.verts:
            # Jacket wins at shared seams so the hem overlaps the trousers.
            if vertex_kind.get(v) != "jacket":
                vertex_kind[v] = kind
    bmesh.ops.delete(bm, geom=remove, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    # Relax the body detail out of the fabric (muscle, toes, anatomy), then
    # lift it off the skin. Skin underneath is removed below, so shrinkage
    # from smoothing cannot expose it.
    # Rubber boots: a convex shell over each foot hides the toes. The hull is
    # built from the existing vertices, so it keeps their skin weights.
    for side in (1, -1):
        foot = [v for v in bm.verts if vertex_kind.get(v) == "boots" and v.co.x * side > 0]
        old_faces = [f for f in bm.faces if all(vertex_kind.get(v) == "boots" and v.co.x * side > 0 for v in f.verts)]
        hull = bmesh.ops.convex_hull(bm, input=foot, use_existing_faces=False)
        shell = {g for g in hull["geom"] if isinstance(g, bmesh.types.BMFace)}
        for face in shell:
            face.material_index = slots["boots"]
            face.smooth = True
        bmesh.ops.delete(bm, geom=[f for f in old_faces if f not in shell], context="FACES_ONLY")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # Smooth across each limb but not along it, so cut seams and bands stay straight.
    for kind, rounds in (("jacket", 30), ("trousers", 12), ("boots", 0)):
        verts = [v for v in bm.verts if vertex_kind.get(v) == kind and not v.is_boundary]
        arms = [v for v in verts if is_arm(clothing.matrix_world @ v.co)]
        trunk = [v for v in verts if not is_arm(clothing.matrix_world @ v.co)]
        for _ in range(rounds):
            bmesh.ops.smooth_vert(bm, verts=arms, factor=0.5, use_axis_x=False, use_axis_y=True, use_axis_z=True)
            bmesh.ops.smooth_vert(bm, verts=trunk, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=kind == "boots")
    # Relax the crease where sleeve and torso smoothing meet.
    jacket = [v for v in bm.verts if vertex_kind.get(v) == "jacket" and not v.is_boundary]
    for _ in range(6):
        bmesh.ops.smooth_vert(bm, verts=jacket, factor=0.35, use_axis_x=True, use_axis_y=True, use_axis_z=False)
    bm.normal_update()
    lift = {"jacket": 0.024, "trousers": 0.010, "boots": 0.018}
    for v in bm.verts:
        kind = vertex_kind.get(v, "jacket")
        extra = 0.008 if kind == "jacket" and abs((clothing.matrix_world @ v.co).x) < 0.2 * s else 0.0
        v.co += v.normal * (lift[kind] + extra) * s
    # A rain jacket hangs past the hips: extrude the hem loop down and out.
    jacket_faces = {f for f in bm.faces if f.material_index in (slots["jacket"], slots.get("band", -1)) and (clothing.matrix_world @ f.calc_center_median()).z > m["hem"]}
    hem = [e for e in bm.edges if len(e.link_faces) == 2 and sum(f in jacket_faces for f in e.link_faces) == 1
           and all(abs(v.co.z - m["hem"]) < 0.03 * s for v in e.verts)]
    hem = largest_loop(hem)
    for drop, flare, band in ((0.10, 1.05, False), (0.035, 1.015, True)):
        made = bmesh.ops.extrude_edge_only(bm, edges=hem)["geom"]
        verts = [g for g in made if isinstance(g, bmesh.types.BMVert)]
        for v in verts:
            v.co.x *= flare
            v.co.y = (v.co.y - 0.02 * s) * flare + 0.02 * s
            v.co.z -= drop * s
        for face in {f for v in verts for f in v.link_faces}:
            face.material_index = slots["band"] if band and spec["bands"] else slots["jacket"]
        hem = [g for g in made if isinstance(g, bmesh.types.BMEdge) and all(v in verts for v in g.verts)]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    bm.to_mesh(clothing.data)
    bm.free()
    for poly in clothing.data.polygons:
        poly.use_smooth = True

    # Remove body skin covered by clothing, keeping a one-face margin at openings.
    bm = bmesh.new()
    bm.from_mesh(body.data)
    skin_faces = {f for f in bm.faces if region_of(body.matrix_world @ f.calc_center_median(), m) == "skin"}
    near_skin = {v for f in skin_faces for v in f.verts}
    hidden = [f for f in bm.faces if f not in skin_faces and not any(v in near_skin for v in f.verts)]
    bmesh.ops.delete(bm, geom=hidden, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(body.data)
    bm.free()
    return clothing


def keep_arms(body, clothing, armature):
    """First-person rig: keep only sleeves and hands; drop head, torso, legs, eyes."""
    m = landmarks(armature)
    s = m["scale"]
    # Forearms only: an upper arm this close to the camera would fill the screen.
    for obj, test in ((clothing, lambda c: c.z > m["arm_z"] - 0.12 * s and abs(c.x) > 0.36 * s),
                      (body, lambda c: abs(c.x) > m["wrist"] - 0.06 * s and c.z > m["arm_z"] - 0.2 * s)):
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        drop = [f for f in bm.faces if not test(obj.matrix_world @ f.calc_center_median())]
        bmesh.ops.delete(bm, geom=drop, context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bm.to_mesh(obj.data)
        bm.free()
    for obj in list(bpy.data.objects):
        if obj.type == "MESH" and obj not in (body, clothing):
            bpy.data.objects.remove(obj, do_unlink=True)


def bake_occlusion(objects):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 48
    scene.render.bake.target = "VERTEX_COLORS"
    for obj in objects:
        attribute = obj.data.color_attributes.new("Occlusion", "BYTE_COLOR", "POINT")
        obj.data.color_attributes.active_color = attribute
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.bake(type="AO")
    # Soften the bake so cloth reads as shaded fabric rather than dirty.
    for obj in objects:
        data = obj.data.color_attributes["Occlusion"].data
        for item in data:
            value = 0.45 + 0.55 * item.color[0]
            item.color = (value, value, value, 1.0)


def shrink_images(prefix):
    for image in bpy.data.images:
        if image.size[0] == 0:
            continue
        name = image.name
        # First matching key wins: eyes and hair before the body maps.
        limit = next((size for key, size in TEXTURE.items() if key in name), 1024)
        if max(image.size) > limit:
            image.scale(limit, limit)
        image.name = f"{prefix}_{name}"


def build(name, spec, clips):
    reset()
    actions = load_clips(clips)
    objects = import_gltf(BODY_DIR / f"Superhero_{spec['body']}_FullBody.gltf", merge=True)
    armature = next(o for o in objects if o.type == "ARMATURE")
    armature.name = "Armature"
    meshes = [o for o in objects if o.type == "MESH"]
    body = max(meshes, key=lambda o: len(o.data.polygons))
    for obj in meshes:
        # The packs carry a helper sphere; only the skinned body and eyes are kept.
        if obj is not body and not obj.name.lower().startswith("eye"):
            bpy.data.objects.remove(obj, do_unlink=True)
    skin = bpy.data.images.load(str(SKIN_DIR / SKIN[(spec["body"], spec["skin"])]))
    for slot in body.material_slots:
        tree = slot.material.node_tree
        for node in tree.nodes:
            if node.type == "TEX_IMAGE" and "Base" in node.image.name or (node.type == "TEX_IMAGE" and node.image.name.startswith("T_Superhero") and "Normal" not in node.image.name and "Rough" not in node.image.name):
                node.image = skin
    if body.data.shape_keys:
        bpy.context.view_layer.objects.active = body
        bpy.ops.object.shape_key_remove(all=True)
    decimate = body.modifiers.new("Decimate", "DECIMATE")
    decimate.ratio = DECIMATE
    decimate.use_collapse_triangulate = True
    decimate.vertex_group_factor = 1.0
    bpy.context.view_layer.objects.active = body
    body.modifiers.move(len(body.modifiers) - 1, 0)
    bpy.ops.object.modifier_apply(modifier="Decimate")
    clothing = dress(body, armature, spec)
    for part in spec["hair"]:
        for obj in import_gltf(HAIR_DIR / f"{part}.gltf"):
            if obj.type != "MESH":
                bpy.data.objects.remove(obj, do_unlink=True)
                continue
            for slot in obj.material_slots:
                shader = slot.material.node_tree.nodes.get("Principled BSDF")
                if shader:
                    shader.inputs["Base Color"].default_value = (*spec["hair_color"], 1)
                    for link in list(shader.inputs["Base Color"].links):
                        # Tint the strand texture rather than replacing it.
                        mix = slot.material.node_tree.nodes.new("ShaderNodeMix")
                        mix.data_type = "RGBA"
                        mix.blend_type = "MULTIPLY"
                        mix.inputs["Factor"].default_value = 1.0
                        mix.inputs["B"].default_value = (*[c * 2.2 for c in spec["hair_color"]], 1)
                        slot.material.node_tree.links.new(link.from_socket, mix.inputs["A"])
                        slot.material.node_tree.links.new(mix.outputs["Result"], shader.inputs["Base Color"])
            matrix = obj.matrix_world.copy()
            obj.parent = armature
            obj.parent_type = "BONE"
            obj.parent_bone = "Head"
            obj.matrix_world = matrix
    for obj in list(bpy.data.objects):
        if obj.type == "MESH" and not any(obj.data.materials):
            bpy.data.objects.remove(obj, do_unlink=True)
    if spec.get("arms"):
        keep_arms(body, clothing, armature)
    bake_occlusion([clothing])
    armature.animation_data_create()
    for action in actions.values():
        armature.animation_data.action = action
        if action.slots:
            armature.animation_data.action_slot = action.slots[0]
        track = armature.animation_data.nla_tracks.new()
        track.name = action.name
        track.strips.new(action.name, int(action.frame_range[0]), action)
    armature.animation_data.action = None
    shrink_images(name)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    target = OUTPUT / f"{name}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(target), export_format="GLB", export_image_format="WEBP",
        export_animation_mode="NLA_TRACKS", export_vertex_color="ACTIVE", export_all_vertex_colors=False,
        export_yup=True, export_apply=False, export_skins=True, export_morph=False,
        export_optimize_animation_size=True, export_extras=False)
    tris = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
    print(f"BUILT {name}: {target.stat().st_size // 1024} KB, {tris} faces, clips {sorted(actions)}")


for cast_name, cast_spec in CAST.items():
    if len(sys.argv) > sys.argv.index("--") + 3 and cast_name not in sys.argv[sys.argv.index("--") + 3:]:
        continue
    build(cast_name, cast_spec, cast_spec["clips"])
