import sys, numpy as np
from PIL import Image
from scipy import ndimage as nd
a=np.asarray(Image.open(sys.argv[1]).convert('L').resize((448,448)))<128
er=nd.binary_erosion(a,iterations=int(sys.argv[3]) if len(sys.argv)>3 else 4)
edge=a&~er
edge=nd.binary_dilation(edge,iterations=1)
Image.fromarray(np.where(edge,20,255).astype(np.uint8)).convert('RGB').save(sys.argv[2])
