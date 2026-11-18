Real `.cnc` files an Avid PRO4848 (Avid EX controller, Centroid CNC12) has run, written by
Vectric's "Avid EX Controllers, Ver 1.2 for 11x and later" post. `tests/test_roscam_post.py`
checks that RosCAM's Avid post (`roscam_post.py`) writes their moves the same way.

- `cut1_2_two_tools.cnc`: 1/4" aluminum sheet, T5 1/4" 3-flute then T2 1/8" (a tool change)
- `profile_2.cnc`: T2 1/8" end mill profile
- `bore.cnc`: T4 1/4" end mill, helical bores
