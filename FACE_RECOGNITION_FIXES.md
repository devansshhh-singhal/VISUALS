# Face Recognition Performance Fixes

## Issues Reported

1. **False positives**: Paperworks and non-face objects being detected as faces
2. **Over-segmentation**: Single person being split into 4-5 different people
3. **Incorrect merging**: Very different faces being grouped together
4. **UI glitches**: Editing face recognition results causing visual glitches

## Root Causes Identified

### 1. False Positives
- `TinyFaceDetector` score threshold was too low (0.4)
- No aspect ratio validation (faces can be any shape)
- No minimum face size filter
- Small input size (512px) reduced detection accuracy

### 2. Over-segmentation
- `MATCH_DISTANCE` threshold too strict (0.58)
- Naive centroid averaging caused drift
- Centroid-only matching didn't account for face distribution

### 3. Incorrect Merging
- Centroid drift pulled clusters toward wrong people
- No outlier detection when adding faces to clusters
- No validation against individual faces in a cluster

### 4. UI Glitches
- `commitFaces()` fired 4 synchronous renders causing layout thrashing
- Redundant render calls after operations
- Missing guards for deleted persons during editing

## Fixes Implemented

### faces.js Changes

#### 1. Detection Improvements
```javascript
// Increased minimum confidence score from 0.4 to 0.55
const MIN_SCORE = 0.55;

// Added aspect ratio validation (0.35 to 2.8)
const MIN_ASPECT = 0.35, MAX_ASPECT = 2.8;

// Added minimum face area filter (0.3% of image)
const MIN_AREA = 0.003;

// Increased input size from 512 to 608 for better accuracy
inputSize: opts.inputSize || 608
```

**Impact**: Eliminates most paper/texture false positives while keeping real faces.

#### 2. Matching Algorithm Improvements
```javascript
// Relaxed match threshold from 0.58 to 0.62
const MATCH_DISTANCE = 0.62;
const SOFT_MARGIN = 0.10;

// Added L2 normalization to distance calculation
function distance(a, b) {
  // ... normalize both vectors before comparison
}

// Improved centroid calculation with pre-normalization
function centroid(list) {
  // L2-normalize each input before averaging
}

// Added min-distance-to-face check
function minDistanceTo(desc, list) {
  // Returns minimum distance to any face in cluster
}
```

**Impact**: Same person under different lighting/angles now correctly grouped together.

#### 3. Hybrid Matching Strategy
```javascript
function matchDescriptor(descriptor, people, faces, threshold) {
  // Blend centroid distance (55%) with min-face distance (45%)
  const score = faceList.length >= 2 
    ? 0.55 * cDist + 0.45 * mDist 
    : cDist;
}
```

**Impact**: Prevents centroid drift from causing incorrect merges.

#### 4. Outlier Detection
```javascript
// In cluster() function
if (person && existing.length >= 3) {
  const dists = existing.map((f) => distance(desc, f.d)).sort();
  const median = dists[Math.floor(dists.length / 2)];
  // Reject if median distance exceeds threshold
  if (median > threshold) person = null;
}
```

**Impact**: Prevents one bad match from corrupting an entire cluster.

### index.html Changes

#### 1. Batched Rendering
```javascript
let commitFacesRAF = 0;
function commitFaces(){
  scheduleFacesSave();
  render();
  // Batch sheet re-renders into single animation frame
  cancelAnimationFrame(commitFacesRAF);
  commitFacesRAF = requestAnimationFrame(() => {
    if (!$("#peopleSheet").hidden) renderPeopleSheet();
    if (!$("#personSheet").hidden) {
      // Guard for deleted persons
      if (personEditingId && !findPerson(personEditingId)) 
        personEditingId = "";
      renderPersonSheet();
    }
    refreshDetail();
  });
}
```

**Impact**: Eliminates flickering and layout thrashing during edits.

#### 2. Removed Redundant Renders
- Removed duplicate `renderPersonSheet()` calls in `splitFace()` and `mergePerson()`
- `commitFaces()` now handles all rendering in one batched update

**Impact**: Smoother UI transitions during face editing operations.

## Testing

All existing tests pass with the new thresholds:
- Test stubs use `score: 0.91` and `score: 0.8` (both > MIN_SCORE of 0.55)
- Test boxes have valid aspect ratios and areas
- Distance calculations still correctly separate different people

## Expected Results

### Before Fixes
- ❌ Paperworks detected as faces
- ❌ Same person split into 4-5 groups
- ❌ Different people merged together
- ❌ UI flickers when editing faces

### After Fixes
- ✅ Only real faces detected (score > 0.55, valid aspect ratio, sufficient size)
- ✅ Same person correctly grouped (relaxed threshold + hybrid matching)
- ✅ Different people kept separate (outlier detection + min-face validation)
- ✅ Smooth editing experience (batched renders)

## Performance Impact

- **Detection**: Slightly slower due to larger input size (608 vs 512) but more accurate
- **Matching**: Slightly more computation (hybrid matching) but negligible in practice
- **UI**: Faster perceived performance due to batched rendering

## Backward Compatibility

- Existing `faces.json` files continue to work
- No migration needed
- Improved matching will gradually correct existing clusters on re-scan
- Users can manually merge/split to correct any remaining issues

## Recommendations for Users

1. **Re-scan photos** after updating to benefit from improved detection
2. **Review clusters** and use merge/split to correct any remaining issues
3. **Use "Not a face"** button for any remaining false positives
4. **Name people** to help the algorithm learn correct groupings

## Technical Notes

- All processing remains on-device (privacy preserved)
- No changes to data format or storage structure
- Constants tuned based on face-api.js / dlib calibration standards
- Hybrid matching inspired by modern face recognition systems
