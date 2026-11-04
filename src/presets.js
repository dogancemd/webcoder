const LANGUAGES = ['python', 'cpp', 'java', 'rust', 'go', 'javascript'];

const TWO_SUM_TEMPLATES = {
  python: `from typing import List, Dict, Optional, Tuple
import collections
import heapq
import math

def solve(nums: List[int], target: int) -> List[int]:
    seen: Dict[int, int] = {}
    for i, num in enumerate(nums):
        complement = target - num
        if complement in seen:
            return [seen[complement], i]
        seen[num] = i
    return []

if __name__ == "__main__":
    # Test cases
    print("Test 1:", solve([2, 7, 11, 15], 9))   # Expected: [0, 1]
    print("Test 2:", solve([3, 2, 4], 6))        # Expected: [1, 2]
    print("Test 3:", solve([3, 3], 6))           # Expected: [0, 1]
`,

  cpp: `#include <iostream>
#include <vector>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <queue>
#include <algorithm>

using namespace std;

class Solution {
public:
    vector<int> solve(const vector<int>& nums, int target) {
        unordered_map<int, int> seen;
        for (int i = 0; i < static_cast<int>(nums.size()); ++i) {
            int complement = target - nums[i];
            if (seen.count(complement)) {
                return {seen[complement], i};
            }
            seen[nums[i]] = i;
        }
        return {};
    }
};

void printVec(const vector<int>& v) {
    cout << "[";
    for (size_t i = 0; i < v.size(); ++i) {
        cout << v[i] << (i + 1 < v.size() ? ", " : "");
    }
    cout << "]" << endl;
}

int main() {
    Solution sol;
    cout << "Test 1: ";
    printVec(sol.solve({2, 7, 11, 15}, 9)); // Expected: [0, 1]
    cout << "Test 2: ";
    printVec(sol.solve({3, 2, 4}, 6));      // Expected: [1, 2]
    cout << "Test 3: ";
    printVec(sol.solve({3, 3}, 6));         // Expected: [0, 1]
    return 0;
}
`,

  java: `import java.util.*;

public class Solution {
    public static int[] solve(int[] nums, int target) {
        Map<Integer, Integer> seen = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            int complement = target - nums[i];
            if (seen.containsKey(complement)) {
                return new int[]{seen.get(complement), i};
            }
            seen.put(nums[i], i);
        }
        return new int[]{};
    }

    public static void main(String[] args) {
        System.out.println("Test 1: " + Arrays.toString(solve(new int[]{2, 7, 11, 15}, 9))); // Expected: [0, 1]
        System.out.println("Test 2: " + Arrays.toString(solve(new int[]{3, 2, 4}, 6)));      // Expected: [1, 2]
        System.out.println("Test 3: " + Arrays.toString(solve(new int[]{3, 3}, 6)));         // Expected: [0, 1]
    }
}
`,

  rust: `use std::collections::HashMap;

fn solve(nums: &[i32], target: i32) -> Vec<i32> {
    let mut seen: HashMap<i32, usize> = HashMap::new();
    for (i, &num) in nums.iter().enumerate() {
        let complement = target - num;
        if let Some(&j) = seen.get(&complement) {
            return vec![j as i32, i as i32];
        }
        seen.insert(num, i);
    }
    vec![]
}

fn main() {
    println!("Test 1: {:?}", solve(&[2, 7, 11, 15], 9)); // Expected: [0, 1]
    println!("Test 2: {:?}", solve(&[3, 2, 4], 6));      // Expected: [1, 2]
    println!("Test 3: {:?}", solve(&[3, 3], 6));         // Expected: [0, 1]
}
`,

  go: `package main

import "fmt"

func solve(nums []int, target int) []int {
    seen := make(map[int]int)
    for i, num := range nums {
        complement := target - num
        if j, ok := seen[complement]; ok {
            return []int{j, i}
        }
        seen[num] = i
    }
    return []int{}
}

func main() {
    fmt.Println("Test 1:", solve([]int{2, 7, 11, 15}, 9)) // Expected: [0 1]
    fmt.Println("Test 2:", solve([]int{3, 2, 4}, 6))      // Expected: [1 2]
    fmt.Println("Test 3:", solve([]int{3, 3}, 6))         // Expected: [0 1]
}
`,

  javascript: `function solve(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (seen.has(complement)) {
      return [seen.get(complement), i];
    }
    seen.set(nums[i], i);
  }
  return [];
}

function main() {
  console.log("Test 1:", solve([2, 7, 11, 15], 9)); // Expected: [0, 1]
  console.log("Test 2:", solve([3, 2, 4], 6));      // Expected: [1, 2]
  console.log("Test 3:", solve([3, 3], 6));         // Expected: [0, 1]
}

main();
`
};

const PROBLEM_PRESETS = [
  {
    id: 'two-sum',
    title: 'Two Sum',
    difficulty: 'Easy',
    prompt: `# Two Sum

Given an array of integers \`nums\` and an integer \`target\`, return *indices of the two numbers such that they add up to \`target\`*.

You may assume that each input would have **exactly one solution**, and you may not use the *same* element twice.

You can return the answer in any order.

---

### Example 1
\`\`\`
Input: nums = [2, 7, 11, 15], target = 9
Output: [0, 1]
Explanation: Because nums[0] + nums[1] == 9, we return [0, 1].
\`\`\`

### Example 2
\`\`\`
Input: nums = [3, 2, 4], target = 6
Output: [1, 2]
\`\`\`

### Constraints
- \`2 <= nums.length <= 10^4\`
- \`-10^9 <= nums[i] <= 10^9\`
- \`-10^9 <= target <= 10^9\`
- **Follow-up:** Can you come up with an algorithm that is less than \`O(n^2)\` time complexity?
`,
    templates: TWO_SUM_TEMPLATES
  },
  {
    id: 'lru-cache',
    title: 'LRU Cache',
    difficulty: 'Medium',
    prompt: `# LRU Cache

Design a data structure that follows the constraints of a **Least Recently Used (LRU) cache**.

Implement the \`LRUCache\` class:
- \`LRUCache(int capacity)\` Initialize the LRU cache with **positive** size \`capacity\`.
- \`int get(int key)\` Return the value of the \`key\` if the key exists, otherwise return \`-1\`.
- \`void put(int key, int value)\` Update the value of the \`key\` if the \`key\` exists. Otherwise, add the \`key-value\` pair to the cache. If the number of keys exceeds the \`capacity\` from this operation, **evict** the least recently used key.

The functions \`get\` and \`put\` must each run in \`O(1)\` average time complexity.

---

### Example
\`\`\`
LRUCache cache = new LRUCache(2);
cache.put(1, 1); // cache is {1=1}
cache.put(2, 2); // cache is {1=1, 2=2}
cache.get(1);    // return 1
cache.put(3, 3); // LRU key was 2, evicts key 2, cache is {1=1, 3=3}
cache.get(2);    // returns -1 (not found)
cache.put(4, 4); // LRU key was 1, evicts key 1, cache is {4=4, 3=3}
cache.get(1);    // return -1 (not found)
cache.get(3);    // return 3
cache.get(4);    // return 4
\`\`\`
`,
    templates: {
      python: `class LRUCache:
    def __init__(self, capacity: int):
        self.capacity = capacity
        # TODO: Initialize your data structures

    def get(self, key: int) -> int:
        # TODO: Implement O(1) get
        return -1

    def put(self, key: int, value: int) -> None:
        # TODO: Implement O(1) put
        pass


if __name__ == "__main__":
    cache = LRUCache(2)
    cache.put(1, 1)
    cache.put(2, 2)
    print("get(1):", cache.get(1))  # Expected: 1
    cache.put(3, 3)
    print("get(2):", cache.get(2))  # Expected: -1
    cache.put(4, 4)
    print("get(1):", cache.get(1))  # Expected: -1
    print("get(3):", cache.get(3))  # Expected: 3
    print("get(4):", cache.get(4))  # Expected: 4
`,
      cpp: `#include <iostream>
#include <unordered_map>
#include <list>

using namespace std;

class LRUCache {
public:
    LRUCache(int capacity) {
        // TODO: Initialize your data structures
    }
    
    int get(int key) {
        // TODO: Implement O(1) get
        return -1;
    }
    
    void put(int key, int value) {
        // TODO: Implement O(1) put
    }
};

int main() {
    LRUCache cache(2);
    cache.put(1, 1);
    cache.put(2, 2);
    cout << "get(1): " << cache.get(1) << " (Expected: 1)" << endl;
    cache.put(3, 3);
    cout << "get(2): " << cache.get(2) << " (Expected: -1)" << endl;
    cache.put(4, 4);
    cout << "get(1): " << cache.get(1) << " (Expected: -1)" << endl;
    cout << "get(3): " << cache.get(3) << " (Expected: 3)" << endl;
    cout << "get(4): " << cache.get(4) << " (Expected: 4)" << endl;
    return 0;
}
`,
      java: `import java.util.*;

public class Solution {
    static class LRUCache {
        public LRUCache(int capacity) {
            // TODO: Initialize your data structures
        }

        public int get(int key) {
            // TODO: Implement O(1) get
            return -1;
        }

        public void put(int key, int value) {
            // TODO: Implement O(1) put
        }
    }

    public static void main(String[] args) {
        LRUCache cache = new LRUCache(2);
        cache.put(1, 1);
        cache.put(2, 2);
        System.out.println("get(1): " + cache.get(1) + " (Expected: 1)");
        cache.put(3, 3);
        System.out.println("get(2): " + cache.get(2) + " (Expected: -1)");
        cache.put(4, 4);
        System.out.println("get(1): " + cache.get(1) + " (Expected: -1)");
        System.out.println("get(3): " + cache.get(3) + " (Expected: 3)");
        System.out.println("get(4): " + cache.get(4) + " (Expected: 4)");
    }
}
`,
      rust: `use std::collections::HashMap;

struct LRUCache {
    capacity: usize,
    // TODO: Initialize your data structures
}

impl LRUCache {
    fn new(capacity: i32) -> Self {
        LRUCache {
            capacity: capacity as usize,
        }
    }

    fn get(&mut self, key: i32) -> i32 {
        // TODO: Implement O(1) get
        -1
    }

    fn put(&mut self, key: i32, value: i32) {
        // TODO: Implement O(1) put
    }
}

fn main() {
    let mut cache = LRUCache::new(2);
    cache.put(1, 1);
    cache.put(2, 2);
    println!("get(1): {} (Expected: 1)", cache.get(1));
    cache.put(3, 3);
    println!("get(2): {} (Expected: -1)", cache.get(2));
    cache.put(4, 4);
    println!("get(1): {} (Expected: -1)", cache.get(1));
    println!("get(3): {} (Expected: 3)", cache.get(3));
    println!("get(4): {} (Expected: 4)", cache.get(4));
}
`,
      go: `package main

import "fmt"

type LRUCache struct {
    capacity int
    // TODO: Initialize your data structures
}

func Constructor(capacity int) LRUCache {
    return LRUCache{capacity: capacity}
}

func (c *LRUCache) Get(key int) int {
    // TODO: Implement O(1) get
    return -1
}

func (c *LRUCache) Put(key int, value int) {
    // TODO: Implement O(1) put
}

func main() {
    cache := Constructor(2)
    cache.Put(1, 1)
    cache.Put(2, 2)
    fmt.Println("get(1):", cache.Get(1), "(Expected: 1)")
    cache.Put(3, 3)
    fmt.Println("get(2):", cache.Get(2), "(Expected: -1)")
    cache.Put(4, 4)
    fmt.Println("get(1):", cache.Get(1), "(Expected: -1)")
    fmt.Println("get(3):", cache.Get(3), "(Expected: 3)")
    fmt.Println("get(4):", cache.Get(4), "(Expected: 4)")
}
`,
      javascript: `class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    // TODO: Initialize your data structures
  }

  get(key) {
    // TODO: Implement O(1) get
    return -1;
  }

  put(key, value) {
    // TODO: Implement O(1) put
  }
}

const cache = new LRUCache(2);
cache.put(1, 1);
cache.put(2, 2);
console.log("get(1):", cache.get(1), "(Expected: 1)");
cache.put(3, 3);
console.log("get(2):", cache.get(2), "(Expected: -1)");
cache.put(4, 4);
console.log("get(1):", cache.get(1), "(Expected: -1)");
console.log("get(3):", cache.get(3), "(Expected: 3)");
console.log("get(4):", cache.get(4), "(Expected: 4)");
`
    }
  },
  {
    id: 'merge-intervals',
    title: 'Merge Intervals',
    difficulty: 'Medium',
    prompt: `# Merge Intervals

Given an array of \`intervals\` where \`intervals[i] = [start_i, end_i]\`, merge all overlapping intervals, and return *an array of the non-overlapping intervals that cover all the intervals in the input*.

---

### Example 1
\`\`\`
Input: intervals = [[1,3],[2,6],[8,10],[15,18]]
Output: [[1,6],[8,10],[15,18]]
Explanation: Since intervals [1,3] and [2,6] overlap, merge them into [1,6].
\`\`\`

### Example 2
\`\`\`
Input: intervals = [[1,4],[4,5]]
Output: [[1,5]]
Explanation: Intervals [1,4] and [4,5] are considered overlapping.
\`\`\`

### Constraints
- \`1 <= intervals.length <= 10^4\`
- \`intervals[i].length == 2\`
- \`0 <= start_i <= end_i <= 10^4\`
`,
    templates: {
      python: `from typing import List

def merge_intervals(intervals: List[List[int]]) -> List[List[int]]:
    # TODO: Implement interval merging
    return []

if __name__ == "__main__":
    print("Test 1:", merge_intervals([[1, 3], [2, 6], [8, 10], [15, 18]]))
    # Expected: [[1, 6], [8, 10], [15, 18]]
    print("Test 2:", merge_intervals([[1, 4], [4, 5]]))
    # Expected: [[1, 5]]
`,
      cpp: `#include <iostream>
#include <vector>
#include <algorithm>

using namespace std;

vector<vector<int>> mergeIntervals(vector<vector<int>> intervals) {
    // TODO: Implement interval merging
    return {};
}

void printIntervals(const vector<vector<int>>& res) {
    cout << "[";
    for (size_t i = 0; i < res.size(); ++i) {
        cout << "[" << res[i][0] << "," << res[i][1] << "]" << (i + 1 < res.size() ? ", " : "");
    }
    cout << "]" << endl;
}

int main() {
    printIntervals(mergeIntervals({{1, 3}, {2, 6}, {8, 10}, {15, 18}}));
    printIntervals(mergeIntervals({{1, 4}, {4, 5}}));
    return 0;
}
`,
      java: `import java.util.*;

public class Solution {
    public static int[][] mergeIntervals(int[][] intervals) {
        // TODO: Implement interval merging
        return new int[][]{};
    }

    public static void main(String[] args) {
        int[][] t1 = {{1, 3}, {2, 6}, {8, 10}, {15, 18}};
        System.out.println("Test 1: " + Arrays.deepToString(mergeIntervals(t1)));
        int[][] t2 = {{1, 4}, {4, 5}};
        System.out.println("Test 2: " + Arrays.deepToString(mergeIntervals(t2)));
    }
}
`,
      rust: `fn merge_intervals(mut intervals: Vec<Vec<i32>>) -> Vec<Vec<i32>> {
    // TODO: Implement interval merging
    vec![]
}

fn main() {
    println!("Test 1: {:?}", merge_intervals(vec![vec![1, 3], vec![2, 6], vec![8, 10], vec![15, 18]]));
    // Expected: [[1, 6], [8, 10], [15, 18]]
    println!("Test 2: {:?}", merge_intervals(vec![vec![1, 4], vec![4, 5]]));
    // Expected: [[1, 5]]
}
`,
      go: `package main

import "fmt"

func mergeIntervals(intervals [][]int) [][]int {
    // TODO: Implement interval merging
    return [][]int{}
}

func main() {
    fmt.Println("Test 1:", mergeIntervals([][]int{{1, 3}, {2, 6}, {8, 10}, {15, 18}}))
    // Expected: [[1 6] [8 10] [15 18]]
    fmt.Println("Test 2:", mergeIntervals([][]int{{1, 4}, {4, 5}}))
    // Expected: [[1 5]]
}
`,
      javascript: `function mergeIntervals(intervals) {
  // TODO: Implement interval merging
  return [];
}

console.log("Test 1:", JSON.stringify(mergeIntervals([[1, 3], [2, 6], [8, 10], [15, 18]])));
// Expected: [[1,6],[8,10],[15,18]]
console.log("Test 2:", JSON.stringify(mergeIntervals([[1, 4], [4, 5]])));
// Expected: [[1,5]]
`
    }
  },
  {
    id: 'number-of-islands',
    title: 'Number of Islands',
    difficulty: 'Medium',
    prompt: `# Number of Islands

Given an \`m x n\` 2D binary grid \`grid\` which represents a map of \`'1'\`s (land) and \`'0'\`s (water), return *the number of islands*.

An **island** is surrounded by water and is formed by connecting adjacent lands horizontally or vertically. You may assume all four edges of the grid are all surrounded by water.

---

### Example 1
\`\`\`
Input: grid = [
  ["1","1","1","1","0"],
  ["1","1","0","1","0"],
  ["1","1","0","0","0"],
  ["0","0","0","0","0"]
]
Output: 1
\`\`\`

### Example 2
\`\`\`
Input: grid = [
  ["1","1","0","0","0"],
  ["1","1","0","0","0"],
  ["0","0","1","0","0"],
  ["0","0","0","1","1"]
]
Output: 3
\`\`\`
`,
    templates: {
      python: `from typing import List

def num_islands(grid: List[List[str]]) -> int:
    # TODO: Count connected components of '1's
    return 0

if __name__ == "__main__":
    g1 = [
        ["1","1","1","1","0"],
        ["1","1","0","1","0"],
        ["1","1","0","0","0"],
        ["0","0","0","0","0"]
    ]
    g2 = [
        ["1","1","0","0","0"],
        ["1","1","0","0","0"],
        ["0","0","1","0","0"],
        ["0","0","0","1","1"]
    ]
    print("Test 1:", num_islands(g1))  # Expected: 1
    print("Test 2:", num_islands(g2))  # Expected: 3
`,
      cpp: `#include <iostream>
#include <vector>

using namespace std;

int numIslands(vector<vector<char>> grid) {
    // TODO: Count connected components of '1's
    return 0;
}

int main() {
    vector<vector<char>> g1 = {
        {'1','1','1','1','0'},
        {'1','1','0','1','0'},
        {'1','1','0','0','0'},
        {'0','0','0','0','0'}
    };
    vector<vector<char>> g2 = {
        {'1','1','0','0','0'},
        {'1','1','0','0','0'},
        {'0','0','1','0','0'},
        {'0','0','0','1','1'}
    };
    cout << "Test 1: " << numIslands(g1) << " (Expected: 1)" << endl;
    cout << "Test 2: " << numIslands(g2) << " (Expected: 3)" << endl;
    return 0;
}
`,
      java: `import java.util.*;

public class Solution {
    public static int numIslands(char[][] grid) {
        // TODO: Count connected components of '1's
        return 0;
    }

    public static void main(String[] args) {
        char[][] g1 = {
            {'1','1','1','1','0'},
            {'1','1','0','1','0'},
            {'1','1','0','0','0'},
            {'0','0','0','0','0'}
        };
        char[][] g2 = {
            {'1','1','0','0','0'},
            {'1','1','0','0','0'},
            {'0','0','1','0','0'},
            {'0','0','0','1','1'}
        };
        System.out.println("Test 1: " + numIslands(g1) + " (Expected: 1)");
        System.out.println("Test 2: " + numIslands(g2) + " (Expected: 3)");
    }
}
`,
      rust: `fn num_islands(grid: Vec<Vec<char>>) -> i32 {
    // TODO: Count connected components of '1's
    0
}

fn main() {
    let g1 = vec![
        vec!['1','1','1','1','0'],
        vec!['1','1','0','1','0'],
        vec!['1','1','0','0','0'],
        vec!['0','0','0','0','0'],
    ];
    let g2 = vec![
        vec!['1','1','0','0','0'],
        vec!['1','1','0','0','0'],
        vec!['0','0','1','0','0'],
        vec!['0','0','0','1','1'],
    ];
    println!("Test 1: {} (Expected: 1)", num_islands(g1));
    println!("Test 2: {} (Expected: 3)", num_islands(g2));
}
`,
      go: `package main

import "fmt"

func numIslands(grid [][]byte) int {
    // TODO: Count connected components of '1's
    return 0
}

func main() {
    g1 := [][]byte{
        {'1','1','1','1','0'},
        {'1','1','0','1','0'},
        {'1','1','0','0','0'},
        {'0','0','0','0','0'},
    }
    g2 := [][]byte{
        {'1','1','0','0','0'},
        {'1','1','0','0','0'},
        {'0','0','1','0','0'},
        {'0','0','0','1','1'},
    }
    fmt.Println("Test 1:", numIslands(g1), "(Expected: 1)")
    fmt.Println("Test 2:", numIslands(g2), "(Expected: 3)")
}
`,
      javascript: `function numIslands(grid) {
  // TODO: Count connected components of '1's
  return 0;
}

const g1 = [
  ["1","1","1","1","0"],
  ["1","1","0","1","0"],
  ["1","1","0","0","0"],
  ["0","0","0","0","0"]
];
const g2 = [
  ["1","1","0","0","0"],
  ["1","1","0","0","0"],
  ["0","0","1","0","0"],
  ["0","0","0","1","1"]
];
console.log("Test 1:", numIslands(g1), "(Expected: 1)");
console.log("Test 2:", numIslands(g2), "(Expected: 3)");
`
    }
  },
  {
    id: 'blank',
    title: 'Blank / Custom Interview Pad',
    difficulty: 'Custom',
    prompt: `# Interview Problem Prompt

Write or paste your interview problem description here using **Markdown**.

### Notes & Requirements
- Clarify input/output types and edge cases
- Discuss time and space complexity (\`O(N)\`)
- Write clean, testable code and run test cases on the right
`,
    templates: {
      python: `def solution():
    print("Hello from Python!")

if __name__ == "__main__":
    solution()
`,
      cpp: `#include <iostream>
#include <vector>
#include <string>

using namespace std;

int main() {
    cout << "Hello from C++!" << endl;
    return 0;
}
`,
      java: `import java.util.*;

public class Solution {
    public static void main(String[] args) {
        System.out.println("Hello from Java!");
    }
}
`,
      rust: `fn main() {
    println!("Hello from Rust!");
}
`,
      go: `package main

import "fmt"

func main() {
    fmt.Println("Hello from Go!")
}
`,
      javascript: `function main() {
  console.log("Hello from JavaScript!");
}

main();
`
    }
  }
];

const DEFAULT_TEMPLATES = PROBLEM_PRESETS.find((p) => p.id === 'blank').templates;

function getPresetById(presetId) {
  return PROBLEM_PRESETS.find((p) => p.id === presetId) || PROBLEM_PRESETS.find((p) => p.id === 'blank');
}

module.exports = {
  LANGUAGES,
  DEFAULT_TEMPLATES,
  PROBLEM_PRESETS,
  getPresetById
};
