# Append extra Mixamo animation FBX as new named clips onto an already-built
# operator.glb (used when the original mesh FBX is no longer around). The glb's
# armature is the mixamorig skeleton at metre scale; the new FBX share that skeleton,
# so their actions bind by bone name. New actions are imported at native cm, so their
# bone-local translation curves are scaled 0.01 to match the baked-metre rest pose.
#
# Usage: blender --background --python scripts/add-anims-to-operator.py -- <in.glb> <out.glb> <anim_dir>
import bpy, os, sys

argv = sys.argv[sys.argv.index("--")+1:]
IN_GLB, OUT_GLB, ANIM_DIR = argv[0], argv[1], argv[2]

CLIP_MAP = {
  "Death From The Front":"DeathFront",
  "Death From The Back":"DeathBack",
  "Death From Right":"DeathRight",
  "Death From Front Headshot":"DeathFrontHead",
  "Death From Back Headshot":"DeathBackHead",
  "reloading":"Reload",
  "toss grenade":"ThrowGrenade",
}

for a in ("io_scene_gltf2","io_scene_fbx"):
    try: bpy.ops.preferences.addon_enable(module=a)
    except Exception: pass

def act_fcurves(act):
    if hasattr(act,"layers") and len(act.layers):
        out=[]
        for l in act.layers:
            for s in l.strips:
                for cb in getattr(s,"channelbags",[]): out.extend(cb.fcurves)
        if out: return out
    return list(getattr(act,"fcurves",[]))

def strip_hips_xz(act):
    for fc in act_fcurves(act):
        if fc.data_path.endswith('.location') and 'Hips' in fc.data_path and fc.array_index in (0,2):
            for kp in fc.keyframe_points:
                kp.co[1]=0.0; kp.handle_left[1]=0.0; kp.handle_right[1]=0.0

def scale_locations(act, s):
    for fc in act_fcurves(act):
        if fc.data_path.endswith('.location'):
            for kp in fc.keyframe_points:
                kp.co[1]*=s; kp.handle_left[1]*=s; kp.handle_right[1]*=s

bpy.ops.wm.read_factory_settings(use_empty=True)

# import the existing operator.glb (armature + mesh + existing clips as actions)
before=set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=IN_GLB)
glb_objs=[o for o in bpy.data.objects if o not in before]
base_arm=next(o for o in glb_objs if o.type=='ARMATURE')
existing=[a for a in bpy.data.actions]
for a in existing: a.use_fake_user=True
print("EXISTING", [a.name for a in existing])

def import_fbx(path):
    b=set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True,
        automatic_bone_orientation=False, ignore_leaf_bones=False)
    return [o for o in bpy.data.objects if o not in b]

new_actions=[]
for fn in sorted(os.listdir(ANIM_DIR)):
    if not fn.lower().endswith(".fbx"): continue
    name=CLIP_MAP.get(os.path.splitext(fn)[0])
    if not name: print("SKIP(no map)", fn); continue
    objs=import_fbx(os.path.join(ANIM_DIR, fn))
    arm=next((o for o in objs if o.type=='ARMATURE'), None)
    act=arm.animation_data.action if (arm and arm.animation_data and arm.animation_data.action) else None
    if act:
        act.name=name; act.use_fake_user=True
        strip_hips_xz(act)
        scale_locations(act, 0.01)   # cm action -> metre-baked armature
        new_actions.append(act)
        print("ADD", fn, "->", name)
    else:
        print("ADD(no action)", fn)
    for o in objs:
        if o.name in bpy.data.objects: bpy.data.objects.remove(o, do_unlink=True)

# rebuild NLA on the base armature so every action (existing + new) exports as a clip
ad=base_arm.animation_data or base_arm.animation_data_create()
ad.action=None
for t in list(ad.nla_tracks): ad.nla_tracks.remove(t)
for act in existing + new_actions:
    tr=ad.nla_tracks.new(); tr.name=act.name
    tr.strips.new(act.name, int(act.frame_range[0]), act)

bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB',
    use_selection=False, export_animation_mode='NLA_TRACKS',
    export_animations=True, export_apply=False, export_yup=True)
print("DONE", OUT_GLB, "clips", [a.name for a in existing+new_actions])
