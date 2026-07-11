# Build the player-character operator.glb from Mixamo FBX drops.
#
# Merges a rigged character mesh (Swat.fbx) with a folder of same-skeleton animation
# FBX files (Shooter Pack/*.fbx) into ONE skinned glTF binary that ships every clip as
# a named glTF animation (Idle, Walk, Run, Death, ...). The game's Animator names its
# states after these clips (see apps/game/src/remote.ts driveAnimation).
#
# Notes on the non-obvious bits (learned the hard way):
#  - Blender 5.x uses the slotted-action API, so fcurves live under layers/channelbags.
#  - Do NOT use bake_space_transform — it corrupts the skin bind (verts shoot to infinity).
#    Instead import native cm, then parent_clear + transform_apply to bake real metres,
#    and rescale the action translation curves by 0.01 to match. glTF drops a *skinned
#    mesh* node's own transform, so an empty-parent scale would render at raw cm / cull.
#  - Hip (root-motion) horizontal translation is zeroed so clips play in place.
#
# Usage: blender --background --python scripts/mixamo-to-operator.py -- <toimport_dir> <out.glb> [extra_anim_dir ...]
#   <toimport_dir>   holds Swat.fbx (mesh) + a "Shooter Pack" folder of loco FBX.
#   [extra_anim_dir] optional flat folders of more Mixamo FBX (deaths/reload/throw).
import bpy, os, sys, mathutils

argv = sys.argv[sys.argv.index("--")+1:]
SRC, OUT = argv[0], argv[1]
EXTRA_DIRS = argv[2:]
MESH_FBX = os.path.join(SRC, "Swat.fbx")

# folder -> { source-fbx-basename (no ext) : glTF clip name }. The game references
# these clip names (apps/game/src/remote.ts). Death From * feed the randomized death set.
ANIM_SOURCES = [
  (os.path.join(SRC, "Shooter Pack"), {
    "rifle aiming idle":"Idle",
    "walking":"Walk",
    "walking backwards":"WalkBack",
    "strafe":"StrafeLeft",
    "strafe (2)":"StrafeRight",
    "rifle run":"Run",
    "run backwards":"RunBack",
    "jump forward":"Jump",
    "jump backward":"JumpBack",
    "start walking":"StartWalk",
    "start walking backwards":"StartWalkBack",
    "stop walking":"StopWalk",
    "walk backwards stop":"StopWalkBack",
    "firing rifle":"Fire",
    "walking to dying":"Death",
  }),
]
EXTRA_MAP = {
  "Death From The Front":"DeathFront",
  "Death From The Back":"DeathBack",
  "Death From Right":"DeathRight",
  "Death From Front Headshot":"DeathFrontHead",
  "Death From Back Headshot":"DeathBackHead",
  "reloading":"Reload",
  "toss grenade":"ThrowGrenade",
}
for d in EXTRA_DIRS:
    ANIM_SOURCES.append((d, EXTRA_MAP))

for addon in ("io_scene_fbx", "io_scene_gltf2"):
    try: bpy.ops.preferences.addon_enable(module=addon)
    except Exception as e: print("addon", addon, e)

def action_fcurves(act):
    # Blender 4.4+/5.x slotted actions: fcurves live under layers→strips→channelbags
    if hasattr(act, "layers") and len(act.layers):
        out = []
        for layer in act.layers:
            for strip in layer.strips:
                for cbag in getattr(strip, "channelbags", []):
                    out.extend(cbag.fcurves)
        if out: return out
    return list(getattr(act, "fcurves", []))

def strip_hips_xz(act):
    n = 0
    for fc in action_fcurves(act):
        if fc.data_path.endswith('.location') and 'Hips' in fc.data_path and fc.array_index in (0, 2):
            for kp in fc.keyframe_points:
                kp.co[1] = 0.0; kp.handle_left[1] = 0.0; kp.handle_right[1] = 0.0
            n += 1
    return n

def scale_action_locations(act, s):
    # after the armature's 0.01 scale is baked into the rest pose, the bone-local
    # translation curves (cm values) read 100x too big — rescale them to match.
    for fc in action_fcurves(act):
        if fc.data_path.endswith('.location'):
            for kp in fc.keyframe_points:
                kp.co[1] *= s; kp.handle_left[1] *= s; kp.handle_right[1] *= s

bpy.ops.wm.read_factory_settings(use_empty=True)

def import_fbx(path):
    before = set(bpy.data.objects)
    # Native import (no bake_space_transform — that corrupts the skin bind and makes
    # verts shoot to infinity). Mixamo verts come in at cm (~190 units tall); we shrink
    # cm->m below with a single empty PARENT node. glTF ignores a *skinned-mesh* node's
    # own transform, but it DOES honor a non-mesh ancestor's transform (skin root parent),
    # so a uniform 0.01 on the parent scales the whole avatar without disturbing weights.
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True,
        automatic_bone_orientation=False, ignore_leaf_bones=False)
    return [o for o in bpy.data.objects if o not in before]

mesh_objs = import_fbx(MESH_FBX)
base_arm = next(o for o in mesh_objs if o.type=='ARMATURE')
base_arm.name = "Armature"
if base_arm.animation_data: base_arm.animation_data.action = None
base_bones = [b.name for b in base_arm.data.bones]
print("BASE_BONES", len(base_bones), base_bones[:6])
print("MESHES", [o.name for o in mesh_objs if o.type=='MESH'])
for o in mesh_objs:
    if o.type=='MESH':
        print("  MATERIALS", o.name, [m.name for m in o.data.materials])

actions = []
for anim_dir, clip_map in ANIM_SOURCES:
    if not os.path.isdir(anim_dir):
        print("SKIP(dir missing)", anim_dir); continue
    for fn in sorted(os.listdir(anim_dir)):
        if not fn.lower().endswith(".fbx"): continue
        key = os.path.splitext(fn)[0]
        name = clip_map.get(key)
        if not name:
            print("SKIP(no map)", fn); continue
        objs = import_fbx(os.path.join(anim_dir, fn))
        arm = next((o for o in objs if o.type=='ARMATURE'), None)
        act = arm.animation_data.action if (arm and arm.animation_data and arm.animation_data.action) else None
        if act:
            act.name = name
            act.use_fake_user = True
            fr = act.frame_range
            removed = strip_hips_xz(act)
            actions.append((name, act))
            print("ANIM", fn, "->", name, "frames", int(fr[0]), int(fr[1]), "strippedXZ", removed)
        else:
            print("ANIM(no action)", fn)
        for o in objs:
            if o.name in bpy.data.objects: bpy.data.objects.remove(o, do_unlink=True)

# Bake the cm->m unit scale into real geometry (verts + armature rest + bind), so the
# glb is clean meter-scale with correct renderer bounds. Empty-parent scaling fails
# because glTF drops a skinned-mesh node's transform AND the wrong bounds get culled.
bpy.ops.object.select_all(action='DESELECT')
bake_objs = [base_arm] + [o for o in mesh_objs if o.type == 'MESH']
for o in bake_objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = base_arm
# detach from the import's 0.01 empty parents, folding that world scale into each object
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
# actions were authored in cm bone-space; match the now-baked meter rest pose
for _n, act in actions:
    scale_action_locations(act, 0.01)
print("BAKED meters; armature scale now", tuple(round(v, 4) for v in base_arm.scale))

if not base_arm.animation_data: base_arm.animation_data_create()
for name, act in actions:
    tr = base_arm.animation_data.nla_tracks.new()
    tr.name = name
    tr.strips.new(name, int(act.frame_range[0]), act)

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB',
    use_selection=False, export_animation_mode='NLA_TRACKS',
    export_animations=True, export_apply=False, export_yup=True)
print("DONE", OUT, "clips", [a[0] for a in actions])
