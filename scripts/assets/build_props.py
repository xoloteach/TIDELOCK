"""Blender 5.2 pipeline: optimise the Poly Haven props for the web build.

Run headless:
  blender -b --python scripts/assets/build_props.py -- <asset-cache> <output-dir>

Each CC0 model is imported at real-world scale, joined into one mesh,
decimated where its polycount is far above what a phone needs at gameplay
distance, its textures are reduced, and it is exported as a single GLB with
WebP textures. Godot places these at their authored metre size.
"""
import sys
from pathlib import Path

import bpy

CACHE, OUTPUT = (Path(p) for p in sys.argv[sys.argv.index("--") + 1:][:2])
# Face budget and texture size per prop; large hero props get more texels.
PROPS = {
    "Barrel_01": (2500, 512), "barrel_03": (1500, 512), "old_military_crate": (3000, 512),
    "plastic_crate_03": (3000, 512), "metal_jerrycan_green": (2500, 256), "old_tyre": (700, 256),
    "lifebuoy": (2500, 256), "portable_generator": (6000, 512), "portable_searchlight": (5000, 512),
    "medical_box": (2000, 256), "metal_toolbox": (3000, 256), "utility_box_01": (3000, 512),
    "security_light": (2500, 256), "trashbag": (2500, 256), "propane_tank": (3000, 256),
    "modular_street_seating": (6000, 512), "hand_truck": (4000, 256),
    "clipboard": (1500, 256), "ocean_buoy": (2500, 512),
    "street_lamp_01": (1200, 512), "concrete_road_barrier": (400, 512), "cement_bag": (150, 256), "wooden_crate_02": (800, 512),
}


def build(name, faces, texture):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(CACHE / "polyhaven" / name / f"{name}.gltf"), merge_vertices=True)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    count = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if count > faces:
        decimate = obj.modifiers.new("Decimate", "DECIMATE")
        decimate.ratio = faces / count
        decimate.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier="Decimate")
    # Godot ignores specular maps, and some fail to re-encode; unlink them.
    for mat in bpy.data.materials:
        if mat.node_tree:
            for link in list(mat.node_tree.links):
                if link.to_socket.name.startswith("Specular"):
                    mat.node_tree.links.remove(link)
    for image in bpy.data.images:
        # Packed AO/roughness/metal maps tolerate half the resolution of colour.
        limit = max(128, texture // 2) if "_arm_" in image.name else texture
        if image.size[0] > limit:
            image.scale(limit, max(1, int(image.size[1] * limit / image.size[0])))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    target = OUTPUT / f"{name.lower()}.glb"
    bpy.ops.export_scene.gltf(filepath=str(target), export_format="GLB", export_image_format="WEBP",
                              export_animations=False, export_extras=False, export_yup=True)
    size = [round(d, 2) for d in obj.dimensions]
    print(f"BUILT {name}: {target.stat().st_size // 1024} KB, {len(obj.data.polygons)} faces, size {size}")


for prop, (budget, pixels) in PROPS.items():
    build(prop, budget, pixels)
